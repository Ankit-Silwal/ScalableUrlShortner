import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkService } from '../src/services/link.service.js';
import { MemoryRepository } from './helpers.js';
import { loadConfig } from '../src/config/env.js';

test('random code collisions retry against unique constraint', async () => {
  const repository = new MemoryRepository();
  await repository.create({ code: 'collision', originalUrl: 'https://example.com' });
  const codes = ['collision', 'available'];
  const service = new LinkService(repository, 'https://sho.rt', () => codes.shift());
  assert.equal((await service.create({ originalUrl: 'https://example.org' })).code, 'available');
});

test('collision retries are bounded', async () => {
  const repository = new MemoryRepository();
  await repository.create({ code: 'collision', originalUrl: 'https://example.com' });
  const service = new LinkService(repository, 'https://sho.rt', () => 'collision');
  await assert.rejects(service.create({ originalUrl: 'https://example.org' }), { status: 503 });
});

test('invalid environment reports fields without exposing secrets', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'secret-value' }), (error) => {
    assert.match(error.message, /DATABASE_URL/);
    assert.ok(!error.message.includes('secret-value'));
    return true;
  });
});
