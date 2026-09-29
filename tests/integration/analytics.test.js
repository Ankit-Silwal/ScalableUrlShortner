import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import Redis from 'ioredis';
import { migrate } from '../../src/config/migrations.js';
import { LinkRepository } from '../../src/repositories/link.repository.js';
import { LinkService } from '../../src/services/link.service.js';
import { LinkCache } from '../../src/infrastructure/link-cache.js';
import { ClickStream, partitionFor, streamFor } from '../../src/infrastructure/click-stream.js';
import { AnalyticsWorker } from '../../src/workers/analytics-worker.js';

test('durable analytics: batches, competing workers, crash replay, rollback, expiry, capacity', {
  skip: (!process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL) && 'Requires TEST_DATABASE_URL and TEST_REDIS_URL',
}, async (t) => {
  const schema = 'test_' + randomBytes(8).toString('hex');
  const prefix = schema;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema });
  const redis = new Redis(process.env.TEST_REDIS_URL);
  await redis.ping();
  t.after(async () => {
    const keys = await redis.keys(prefix + ':*');
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await migrate(pool);
  const repository = new LinkRepository(pool);
  const cache = new LinkCache(redis, { prefix, ttlSeconds: 60 });
  const outcomes = [];
  const metrics = { analytics: { inc: (labels) => outcomes.push(labels.result) } };
  const analytics = new ClickStream(redis, { prefix, maxLength: 1000, metrics });
  const service = new LinkService(repository, 'https://sho.rt', undefined, { cache, analytics });
  const first = new AnalyticsWorker({ pool, redis, prefix, batchSize: 50 });
  const second = new AnalyticsWorker({ pool, redis, prefix, batchSize: 50 });
  await first.initialize();
  await second.initialize();
  await service.create({ originalUrl: 'https://example.com', customAlias: 'popular' });
  await Promise.all(Array.from({ length: 120 }, () => service.resolve('popular')));
  assert.equal((await repository.findByCode('popular')).clicks, 0, 'redirects enqueue without database writes');
  await Promise.all([first.tick(), second.tick()]);
  await first.tick();
  assert.equal((await repository.findByCode('popular')).clicks, 120);
  await service.resolve('popular', false);
  await first.tick();
  assert.equal((await repository.findByCode('popular')).clicks, 120);

  // Crash after COMMIT but before Redis trimming: retained entries must not replay.
  await service.resolve('popular');
  const originalTrim = redis.xtrim.bind(redis);
  redis.xtrim = async () => { throw new Error('simulated crash after commit'); };
  await assert.rejects(first.processPartition(partitionFor('popular')), /simulated crash/);
  assert.equal((await repository.findByCode('popular')).clicks, 121);
  redis.xtrim = originalTrim;
  await second.processPartition(partitionFor('popular'));
  assert.equal((await repository.findByCode('popular')).clicks, 121, 'checkpoint prevents double application');

  // Database failure rolls back both the count and the checkpoint.
  await service.resolve('popular');
  await pool.query(`CREATE FUNCTION reject_analytics() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated write failure'; END $$`);
  await pool.query('CREATE TRIGGER fail_analytics BEFORE UPDATE ON links FOR EACH ROW EXECUTE FUNCTION reject_analytics()');
  await assert.rejects(first.processPartition(partitionFor('popular')), /simulated write failure/);
  await pool.query('DROP TRIGGER fail_analytics ON links');
  await second.processPartition(partitionFor('popular'));
  assert.equal((await repository.findByCode('popular')).clicks, 122);

  await service.create({ originalUrl: 'https://example.com', customAlias: 'expired', expiresAt: new Date(0) });
  await assert.rejects(service.resolve('expired'), { status: 410 });
  await service.delete('popular');
  await assert.rejects(service.resolve('popular'), { status: 404 });
  await assert.rejects(service.create({ originalUrl: 'https://example.org', customAlias: 'popular' }), { status: 409 });

  const bounded = new ClickStream(redis, { prefix: prefix + ':bounded', maxLength: 2, metrics });
  await bounded.record('bounded', new Date());
  await bounded.record('bounded', new Date());
  await bounded.record('bounded', new Date());
  assert.equal(outcomes.at(-1), 'dropped_full');
  assert.equal(await redis.xlen(streamFor(prefix + ':bounded', partitionFor('bounded'))), 2);
  const unavailable = new ClickStream({ eval: async () => { throw new Error('offline'); } }, { prefix, maxLength: 2, metrics });
  await unavailable.record('bounded', new Date());
  assert.equal(outcomes.at(-1), 'dropped_error');
});

test('PostgreSQL cursor pagination preserves sub-millisecond ordering', {
  skip: !process.env.TEST_DATABASE_URL && 'Requires TEST_DATABASE_URL',
}, async (t) => {
  const schema = 'test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema });
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
  await migrate(pool);
  await pool.query(`INSERT INTO links(code, original_url, created_at) VALUES
    ('aaaa', 'https://example.com', '2026-01-01T00:00:00.123456Z'),
    ('bbbb', 'https://example.com', '2026-01-01T00:00:00.123455Z'),
    ('cccc', 'https://example.com', '2026-01-01T00:00:00.123454Z')`);
  const service = new LinkService(new LinkRepository(pool), 'https://sho.rt');
  const codes = [];
  let cursor;
  do {
    const page = await service.list({ limit: 1, cursor });
    codes.push(...page.data.map((link) => link.code));
    cursor = page.pagination.nextCursor;
  } while (cursor);
  assert.deepEqual(codes, ['aaaa', 'bbbb', 'cccc']);
});
