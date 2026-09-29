import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadTest } from '../scripts/load-test.js';

test('load generator records rate-limit responses as failures, not successful redirects', async (t) => {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    res.writeHead(count % 4 === 0 ? 429 : 302, { location: 'https://example.com' });
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await loadTest({ origins: ['http://127.0.0.1:' + server.address().port], durationSeconds: 1, concurrency: 2 });
  assert.equal(result.errors, 0);
  assert.ok(result.statuses[302] > 0);
  assert.ok(result.statuses[429] > 0);
  assert.equal(result.unexpectedResponses, result.statuses[429]);
  assert.equal(result.completed, result.statuses[302] + result.statuses[429]);
  assert.ok(result.latencyMs.p95 >= result.latencyMs.p50);
});

test('load generator refuses invalid duration or concurrency', async () => {
  await assert.rejects(loadTest({ origins: ['http://localhost'], durationSeconds: 0 }), /Invalid load-test configuration/);
  await assert.rejects(loadTest({ origins: ['http://localhost'], concurrency: Infinity }), /Invalid load-test configuration/);
});
