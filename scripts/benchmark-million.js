import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpus, totalmem, platform } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import Redis from 'ioredis';
import { migrate } from '../src/config/migrations.js';
import { loadTest } from './load-test.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Set TEST_DATABASE_URL and TEST_REDIS_URL to dedicated test services');
const rowCount = Number(process.env.BENCH_LINKS ?? 1000000);
const durationSeconds = Number(process.env.BENCH_DURATION_SECONDS ?? 15);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 32);
if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) throw new Error('Invalid benchmark duration/concurrency');
if (!Number.isInteger(rowCount) || rowCount < 1000 || rowCount > 10000000) throw new Error('BENCH_LINKS must be 1000..10000000');
const schema = 'bench_' + randomBytes(8).toString('hex');
const prefix = schema;
const admin = new pg.Pool({ connectionString: databaseUrl });
const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=' + schema });
const redis = new Redis(redisUrl);
const children = [];
const key = randomBytes(32).toString('hex');
let schemaCreated = false;
async function port() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const result = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return result;
}
async function ready(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Service failed during benchmark startup');
    try { if ((await fetch(url + '/ready', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Service readiness deadline exceeded');
}
function launch(file, env) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => process.stderr.write(data));
  child.stderr.on('data', (data) => process.stderr.write(data));
  children.push(child);
  return child;
}
function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}
let report;
try {
  await admin.query('CREATE SCHEMA ' + schema);
  schemaCreated = true;
  await migrate(pool);
  console.log('Seeding ' + rowCount + ' links in an isolated PostgreSQL schema...');
  const began = performance.now();
  await pool.query(`INSERT INTO links (code, original_url, created_at)
    SELECT 'bench_' || lpad(i::text, 8, '0'), 'https://example.com/resource/' || i,
      NOW() - (i * interval '1 millisecond')
    FROM generate_series(1, $1::integer) AS i`, [rowCount]);
  await pool.query('ANALYZE links');
  const seedSeconds = (performance.now() - began) / 1000;
  const databaseSize = (await pool.query("SELECT pg_total_relation_size('links') AS bytes")).rows[0].bytes;
  const boundary = (await pool.query("SELECT code, created_at::text AS created_at FROM links WHERE code = $1",
    ['bench_' + String(Math.floor(rowCount * 0.9)).padStart(8, '0')])).rows[0];
  const lookupPlan = (await pool.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM links WHERE code = 'bench_00500000' AND deleted_at IS NULL")).rows[0]['QUERY PLAN'];
  const cursorPlan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT code, original_url FROM links WHERE deleted_at IS NULL AND (created_at, code) < ($1::timestamptz, $2)
    ORDER BY created_at DESC, code DESC LIMIT 21`, [boundary.created_at, boundary.code])).rows[0]['QUERY PLAN'];
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set('options', '-c search_path=' + schema);
  const apiPorts = [await port(), await port()];
  const workerPort = await port();
  const common = {
    NODE_ENV: 'production', DATABASE_URL: scopedUrl.href, REDIS_URL: redisUrl, REDIS_PREFIX: prefix,
    API_KEY: key, BASE_URL: 'http://localhost:' + apiPorts[0], LOG_LEVEL: 'error', HTTP_LOG_ENABLED: 'false',
    API_RATE_LIMIT: '1000000', REDIRECT_RATE_LIMIT: '100000000', RATE_LIMIT_WINDOW_MS: '60000',
    DB_POOL_MAX: '10', DB_QUERY_TIMEOUT_MS: '5000', MAX_INFLIGHT_REQUESTS: '500',
    ANALYTICS_STREAM_MAX_LENGTH: '500000', ANALYTICS_BATCH_SIZE: '500', ANALYTICS_POLL_MS: '50',
    CACHE_TTL_SECONDS: '120', REDIS_TIMEOUT_MS: '1000', TRUST_PROXY_HOPS: '0',
  };
  const origins = apiPorts.map((value) => 'http://127.0.0.1:' + value);
  for (let i = 0; i < apiPorts.length; i++) {
    const child = launch('src/server.js', { ...common, PORT: String(apiPorts[i]) });
    await ready(origins[i], child);
  }
  const worker = launch('src/worker.js', { ...common, WORKER_PORT: String(workerPort) });
  await ready('http://127.0.0.1:' + workerPort, worker);
  const path = (id) => '/bench_' + String(id).padStart(8, '0');
  const warmup = await loadTest({ origins, durationSeconds: 3, concurrency: 8, pathFor: () => path(1) });
  const results = [];
  for (const [name, pathFor] of [
    ['hot-link', () => path(1)],
    ['mixed-80-percent-hot', (id) => path(id % 5 ? 1 + id % 100 : 1 + (id * 7919) % rowCount)],
    ['uniform-million-links', (id) => path(1 + (id * 7919) % rowCount)],
  ]) {
    console.log('Measuring ' + name + '...');
    results.push({ name, ...await loadTest({ origins, durationSeconds, concurrency, pathFor }) });
  }
  const expectedClicks = [warmup, ...results].reduce((sum, result) => sum + (result.statuses[302] ?? 0), 0);
  let appliedClicks = 0;
  const drainStart = performance.now();
  for (let i = 0; i < 60; i++) {
    appliedClicks = Number((await pool.query('SELECT SUM(clicks) AS count FROM links')).rows[0].count);
    if (appliedClicks >= expectedClicks) break;
    await delay(1000);
  }
  const apiMetrics = await Promise.all(origins.map(async (origin) => (await fetch(origin + '/metrics', { headers: { 'x-api-key': key } })).text()));
  const workerMetrics = await (await fetch('http://127.0.0.1:' + workerPort + '/metrics', { headers: { 'x-api-key': key } })).text();
  report = {
    measuredAt: new Date().toISOString(), datasetRows: rowCount,
    topology: '2 separate Node API processes, 1 worker, Docker PostgreSQL and Redis; direct round-robin client, no Nginx in timed path',
    host: { platform: platform(), node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)) },
    seedSeconds: Number(seedSeconds.toFixed(2)), tableAndIndexBytes: Number(databaseSize),
    warmup, results, expectedClicks, appliedClicks,
    drainSeconds: Number(((performance.now() - drainStart) / 1000).toFixed(2)),
    // Raw bounded-label metrics also accompany the summary for independent inspection.
    lookupPlan, cursorPlan,
    limitations: [
      'Short local closed-loop test; not a 24-hour soak, availability SLA, or production capacity guarantee.',
      'Load generator, API processes, worker and database share one host.',
      'Rate limits deliberately raised for load generation; production defaults remain enabled.',
      'Test Redis has persistence disabled; repeat with production AOF, TLS, gateway, and workload before deployment.',
    ],
  };
  // Extract exact labelled values separately because labels are part of the sample name.
  report.cacheHits = apiMetrics.reduce((sum, text) => sum + Number(text.match(/shortener_cache_total\{result="hit"\} (\d+)/)?.[1] ?? 0), 0);
  report.cacheMisses = apiMetrics.reduce((sum, text) => sum + Number(text.match(/shortener_cache_total\{result="miss"\} (\d+)/)?.[1] ?? 0), 0);
  report.analyticsBatches = Number(workerMetrics.match(/shortener_analytics_batches_total (\d+)/)?.[1] ?? 0);
  await mkdir('benchmark-results', { recursive: true });
  await writeFile('benchmark-results/latest.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile('benchmark-results/latest.prom', apiMetrics.join('\n') + '\n' + workerMetrics);
  console.log(JSON.stringify({ datasetRows: rowCount, results, expectedClicks, appliedClicks, analyticsBatches: report.analyticsBatches }, null, 2));
  if (results.some((result) => result.errors || result.unexpectedResponses) || appliedClicks !== expectedClicks) process.exitCode = 1;
} finally {
  await Promise.all(children.map(stop));
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 1000);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
  redis.disconnect();
  await pool.end();
  if (schemaCreated) await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
  await admin.end();
}
