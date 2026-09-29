import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkService } from '../src/services/link.service.js';
import { fixture, MemoryRepository } from './helpers.js';
import { loadConfig } from '../src/config/env.js';
import { encodeCursor, decodeCursor } from '../src/utils/cursor.js';

test('cached redirects do not write PostgreSQL and still enforce expiry', async () => {
  let queued = 0;
  const service = new LinkService({}, 'https://sho.rt', undefined, {
    cache: { get: async () => ({ originalUrl: 'https://example.com', expiresAt: new Date(Date.now() + 60000) }) },
    analytics: { record: async () => { queued++; } },
  });
  assert.equal(await service.resolve('cached'), 'https://example.com');
  assert.equal(queued, 1);
  await service.resolve('cached', false);
  assert.equal(queued, 1);
  service.cache.get = async () => ({ originalUrl: 'https://example.com', expiresAt: new Date(0) });
  await assert.rejects(service.resolve('cached'), { status: 410 });
  assert.equal(queued, 1);
});

test('concurrent cache misses coalesce and cache failures fall back to PostgreSQL', async () => {
  let reads = 0;
  const repository = { findByCode: async () => {
    reads++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { originalUrl: 'https://example.com' };
  } };
  const service = new LinkService(repository, 'https://sho.rt', undefined, {
    cache: { get: async () => { throw new Error('offline'); }, remember: async () => { throw new Error('offline'); } },
  });
  await Promise.all(Array.from({ length: 20 }, () => service.resolve('cached', false)));
  assert.equal(reads, 1);
  assert.equal(service.inflight.size, 0);
});

test('cursor preserves microsecond timestamps and rejects malformed input', () => {
  const cursor = encodeCursor({ code: 'cursor', cursorTimestamp: '2026-01-01T00:00:00.123456Z' });
  assert.deepEqual(decodeCursor(cursor), { code: 'cursor', createdAt: '2026-01-01T00:00:00.123456Z' });
  assert.throws(() => decodeCursor('garbage'), { status: 400 });
});

test('cursor API traverses links without duplicates; deleted aliases stay reserved', async (t) => {
  const { request } = await fixture(t);
  for (const customAlias of ['aaaa', 'bbbb', 'cccc']) {
    assert.equal((await request('/api/v1/links', { method: 'POST', body: { originalUrl: 'https://example.com', customAlias } })).status, 201);
  }
  const first = await (await request('/api/v1/links?limit=2')).json();
  assert.equal(first.data.length, 2);
  assert.ok(first.pagination.nextCursor);
  const second = await (await request('/api/v1/links?limit=2&cursor=' + first.pagination.nextCursor)).json();
  assert.equal(second.data.length, 1);
  assert.equal(second.pagination.nextCursor, null);
  assert.equal(new Set([...first.data, ...second.data].map((link) => link.code)).size, 3);
  assert.equal((await request('/api/v1/links?page=2')).status, 400);
  await request('/api/v1/links/aaaa', { method: 'DELETE' });
  assert.equal((await request('/api/v1/links', { method: 'POST', body: { originalUrl: 'https://example.org', customAlias: 'aaaa' } })).status, 409);
});

test('production rejects process-local rate limit configuration', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production', BASE_URL: 'https://sho.rt', DATABASE_URL: 'postgresql://localhost/test',
    API_KEY: 'x'.repeat(32),
  }), /REDIS_URL/);
});

test('overload shedding bounds in-flight work and metrics require authentication', async (t) => {
  const { createMetrics } = await import('../src/infrastructure/metrics.js');
  let release;
  const repository = new MemoryRepository();
  repository.list = async () => { await new Promise((resolve) => { release = resolve; }); return []; };
  const { request } = await fixture(t, { repository, config: { MAX_INFLIGHT_REQUESTS: 1 }, metrics: createMetrics() });
  const first = request('/api/v1/links');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal((await request('/api/v1/links')).status, 503);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await request('/metrics', { auth: false })).status, 401);
  assert.match(await (await request('/metrics')).text(), /shortener_http_duration_seconds/);
});
