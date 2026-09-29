import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('create, redirect, HEAD, stats, list, delete lifecycle', async (t) => {
  const { request } = await fixture(t);
  const created = await request('/api/v1/links', { method: 'POST', body: { originalUrl: 'https://example.com/path?q=1', customAlias: 'my-link' } });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.shortUrl, 'https://sho.rt/my-link');
  assert.equal(created.headers.get('location'), '/api/v1/links/my-link');
  const redirect = await request('/my-link', { auth: false });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/path?q=1');
  assert.equal(redirect.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/my-link', { method: 'HEAD', auth: false })).status, 302);
  const stats = await (await request('/api/v1/links/my-link')).json();
  assert.equal(stats.data.clicks, 1);
  const list = await (await request('/api/v1/links?page=1&limit=10')).json();
  assert.equal(list.data.length, 1);
  assert.equal((await request('/api/v1/links/my-link', { method: 'DELETE' })).status, 204);
  assert.equal((await request('/my-link', { auth: false })).status, 404);
});

test('management requires API key', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/v1/links', { auth: false })).status, 401);
  assert.equal((await request('/api/v1/links', { headers: { 'x-api-key': 'bad' } })).status, 401);
});

test('rejects invalid URLs, aliases, expiration, pagination, and unknown fields', async (t) => {
  const { request } = await fixture(t);
  for (const body of [
    { originalUrl: 'javascript:alert(1)' },
    { originalUrl: 'https://user:secret@example.com' },
    { originalUrl: 'https://example.com', customAlias: 'health' },
    { originalUrl: 'https://example.com', customAlias: '../bad' },
    { originalUrl: 'https://example.com', expiresAt: '2000-01-01T00:00:00Z' },
    { originalUrl: 'https://example.com', clicks: 900 },
  ]) {
    const response = await request('/api/v1/links', { method: 'POST', body });
    assert.equal(response.status, 400);
  }
  assert.equal((await request('/api/v1/links?limit=101')).status, 400);
});

test('duplicate alias conflicts and expired links return 410 without counting', async (t) => {
  const { request, repository } = await fixture(t);
  const body = { originalUrl: 'https://example.com', customAlias: 'duplicate' };
  await request('/api/v1/links', { method: 'POST', body });
  assert.equal((await request('/api/v1/links', { method: 'POST', body })).status, 409);
  await repository.create({ code: 'expired', originalUrl: 'https://example.com', expiresAt: new Date(0) });
  assert.equal((await request('/expired', { auth: false })).status, 410);
  assert.equal((await repository.findByCode('expired')).clicks, 0);
});

test('malformed JSON and oversized bodies get consistent errors', async (t) => {
  const { request } = await fixture(t);
  const malformed = await request('/api/v1/links', { method: 'POST', rawBody: '{invalid', headers: { 'content-type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  assert.equal((await request('/api/v1/links', { method: 'POST', body: { originalUrl: 'x'.repeat(17000) } })).status, 413);
});

test('rate limits and readiness', async (t) => {
  const { request } = await fixture(t, { config: { API_RATE_LIMIT: 1 }, isReady: async () => false });
  assert.equal((await request('/health', { auth: false })).status, 200);
  assert.equal((await request('/ready', { auth: false })).status, 503);
  assert.equal((await request('/api/v1/links')).status, 200);
  const limited = await request('/api/v1/links');
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
});

test('unexpected repository errors are sanitized', async (t) => {
  const { request } = await fixture(t, { repository: { list() { throw new Error('secret database password'); } } });
  const response = await request('/api/v1/links');
  assert.equal(response.status, 500);
  const payload = await response.json();
  assert.equal(payload.error.code, 'INTERNAL_ERROR');
  assert.ok(payload.requestId);
  assert.ok(!JSON.stringify(payload).includes('secret'));
});
