import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/config/migrations.js';
import { LinkRepository } from '../../src/repositories/link.repository.js';
import { fixture } from '../helpers.js';

test('PostgreSQL migrations, concurrency, expiry and complete HTTP lifecycle', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run real PostgreSQL tests',
}, async (t) => {
  const schema = 'test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema });
  t.after(async () => {
    await pool.end();
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await migrate(pool);
  await migrate(pool);
  assert.equal((await pool.query('SELECT * FROM schema_migrations')).rows.length, 3);
  const repository = new LinkRepository(pool);
  const { request } = await fixture(t, { repository });
  const body = { originalUrl: 'https://example.com/a?b=1', customAlias: 'parallel' };
  const creations = await Promise.all(Array.from({ length: 8 }, () => request('/api/v1/links', { method: 'POST', body })));
  assert.equal(creations.filter((response) => response.status === 201).length, 1);
  assert.equal(creations.filter((response) => response.status === 409).length, 7);
  const redirects = await Promise.all(Array.from({ length: 30 }, () => request('/parallel', { auth: false })));
  assert.ok(redirects.every((response) => response.status === 302));
  assert.equal((await repository.findByCode('parallel')).clicks, 30);
  assert.equal((await request('/parallel', { method: 'HEAD', auth: false })).status, 302);
  assert.equal((await repository.findByCode('parallel')).clicks, 30);
  const stats = await (await request('/api/v1/links/parallel')).json();
  assert.equal(stats.data.originalUrl, body.originalUrl);
  assert.equal((await (await request('/api/v1/links?limit=1')).json()).data.length, 1);
  await repository.create({ code: 'expired', originalUrl: body.originalUrl, expiresAt: new Date(0) });
  assert.equal((await request('/expired', { auth: false })).status, 410);
  assert.equal((await repository.findByCode('expired')).clicks, 0);
  assert.equal(await repository.findByCode("' OR 1=1 --"), null);
  assert.equal((await request('/api/v1/links/parallel', { method: 'DELETE' })).status, 204);
  assert.equal((await request('/parallel', { auth: false })).status, 404);
});
