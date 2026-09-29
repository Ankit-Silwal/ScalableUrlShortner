import { ClickStream } from './infrastructure/click-stream.js';
import { createRedis } from './config/redis.js';
import { LinkCache } from './infrastructure/link-cache.js';
import { createMetrics } from './infrastructure/metrics.js';
import pino from 'pino';
import { loadConfig } from './config/env.js';
import { createPool, isDatabaseReady } from './config/database.js';
import { LinkRepository } from './repositories/link.repository.js';
import { createApp } from './app.js';

let logger = pino();
let server;
let pool;
let redis;
let stopping = false;
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    redis?.disconnect();
    await pool?.end();
    clearTimeout(deadline);
    process.exitCode = exitCode;
  } catch {
    process.exit(1);
  }
}

try {
  const config = loadConfig();
  logger = pino({ level: config.LOG_LEVEL });
  pool = createPool(config, logger);
  if (!await isDatabaseReady(pool)) throw new Error('Database is unavailable or migrations are missing');
  redis = createRedis(config, logger);
  if (redis) await redis.connect();
  const metrics = createMetrics();
  const cache = redis ? new LinkCache(redis, { prefix: config.REDIS_PREFIX, ttlSeconds: config.CACHE_TTL_SECONDS }) : null;
  const analytics = redis ? new ClickStream(redis, { prefix: config.REDIS_PREFIX, maxLength: config.ANALYTICS_STREAM_MAX_LENGTH, metrics }) : null;
  const app = createApp({ config, repository: new LinkRepository(pool), logger, redis, cache, analytics, metrics,
    isReady: async () => !stopping && (!redis || redis.status === 'ready') && await isDatabaseReady(pool),
  });
  server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'URL shortener listening'));
  server.on('error', (error) => { logger.error({ errorType: error.code }, 'HTTP server failed'); void shutdown(1); });
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
} catch (error) {
  // Connection errors can embed credentials; configuration errors are sanitized.
  logger.fatal({ errorType: error.name }, error.message.startsWith('Invalid environment configuration:') ? error.message : 'Startup failed. Check PostgreSQL connectivity, Redis, migrations, and configuration.');
  await shutdown(1);
}
