import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { LinkCache } from '../../src/infrastructure/link-cache.js';
import { fixture } from '../helpers.js';

test('real Redis cache tombstones and rate limits are shared by two API replicas', {
  skip: !process.env.TEST_REDIS_URL && 'Set TEST_REDIS_URL to run Redis tests',
}, async (t) => {
  const redis = new Redis(process.env.TEST_REDIS_URL, { lazyConnect: true });
  await redis.connect();
  const prefix = 'test:' + randomUUID();
  t.after(async () => {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, 'MATCH', prefix + ':*', 'COUNT', 100);
      cursor = result[0];
      if (result[1].length) await redis.del(...result[1]);
    } while (cursor !== '0');
    redis.disconnect();
  });
  const cache = new LinkCache(redis, { prefix, ttlSeconds: 30 });
  await cache.remember('cached', { code: 'cached', originalUrl: 'https://example.com' });
  assert.equal((await cache.get('cached')).originalUrl, 'https://example.com');
  await cache.deleted('cached');
  await cache.remember('cached', { originalUrl: 'https://stale.example.com' });
  assert.equal(await cache.get('cached'), null);
  await cache.remember('future', null);
  await cache.created({ code: 'future', originalUrl: 'https://example.org' });
  assert.equal((await cache.get('future')).originalUrl, 'https://example.org');
  const config = { REDIS_PREFIX: prefix, API_RATE_LIMIT: 2 };
  const one = await fixture(t, { redis, config });
  const two = await fixture(t, { redis, config });
  assert.equal((await one.request('/api/v1/links')).status, 200);
  assert.equal((await two.request('/api/v1/links')).status, 200);
  assert.equal((await one.request('/api/v1/links')).status, 429);
  redis.disconnect();
  assert.equal((await two.request('/api/v1/links')).status, 503);
  await redis.connect();
});
