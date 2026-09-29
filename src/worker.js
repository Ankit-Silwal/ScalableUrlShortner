import express from 'express';
import pino from 'pino';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config/env.js';
import { createPool, isDatabaseReady } from './config/database.js';
import { createRedis } from './config/redis.js';
import { createMetrics } from './infrastructure/metrics.js';
import { requireApiKey } from './middleware/auth.js';
import { AnalyticsWorker } from './workers/analytics-worker.js';

let logger = pino();
let pool, redis, server, loop;
let stopping = false;
let lastSuccess = 0;
const abort = new AbortController();
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  abort.abort();
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await loop;
    redis?.disconnect();
    await pool?.end();
    clearTimeout(deadline);
    process.exitCode = code;
  } catch { process.exit(1); }
}
try {
  const config = loadConfig();
  logger = pino({ level: config.LOG_LEVEL });
  if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the analytics worker');
  pool = createPool(config, logger);
  redis = createRedis(config, logger);
  await redis.connect();
  if (!await isDatabaseReady(pool)) throw new Error('Database unavailable');
  const metrics = createMetrics();
  const worker = new AnalyticsWorker({
    pool, redis, prefix: config.REDIS_PREFIX, batchSize: config.ANALYTICS_BATCH_SIZE, metrics,
  });
  await worker.initialize();
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (req, res) => {
    const ready = !stopping && Date.now() - lastSuccess < 30000 && redis.status === 'ready';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  app.get('/metrics', requireApiKey(config.API_KEY), async (req, res) => res.type(metrics.registry.contentType).send(await metrics.registry.metrics()));
  server = app.listen(config.WORKER_PORT, () => logger.info({ port: config.WORKER_PORT }, 'Analytics worker listening'));
  server.on('error', () => { void shutdown(1); });
  loop = (async () => {
    while (!stopping) {
      let count = 0;
      try { count = await worker.tick(); lastSuccess = Date.now(); }
      catch (error) { logger.error({ errorType: error.code ?? error.name }, 'Analytics batch failed; checkpoint retained for retry'); }
      if (!count && !stopping) await delay(config.ANALYTICS_POLL_MS, undefined, { signal: abort.signal }).catch(() => {});
    }
  })();
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
} catch (error) {
  logger.fatal({ errorType: error.name }, 'Worker startup failed. Check PostgreSQL, Redis, and migrations.');
  await shutdown(1);
}
