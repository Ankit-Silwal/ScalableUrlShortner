import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const env = {
  ...process.env,
  API_KEY: randomBytes(32).toString('hex'),
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  BASE_URL: 'http://localhost:18080', GATEWAY_PORT: '18080',
};
const compose = ['compose', '-p', 'shortener-smoke', '-f', 'compose.scale.yaml'];
async function run(args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let output = '';
    if (capture) child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error('Docker command exited ' + code)));
  });
}
const request = (path, options = {}) => fetch(env.BASE_URL + path, {
  redirect: 'manual', headers: { 'x-api-key': env.API_KEY, 'content-type': 'application/json' },
  signal: AbortSignal.timeout(10000), ...options,
});
try {
  await run([...compose, 'up', '-d', '--no-build', '--wait', '--scale', 'api=3', '--scale', 'worker=2']);
  assert.equal((await request('/ready')).status, 200);
  const created = await request('/api/v1/links', { method: 'POST', body: JSON.stringify({ originalUrl: 'https://example.com/smoke', customAlias: 'smoke-link' }) });
  assert.equal(created.status, 201);
  const responses = await Promise.all(Array.from({ length: 90 }, () => request('/smoke-link')));
  assert.ok(responses.every((response) => response.status === 302 && response.headers.get('location') === 'https://example.com/smoke'));
  let clicks = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    clicks = (await (await request('/api/v1/links/smoke-link')).json()).data.clicks;
    if (clicks === 90) break;
    await delay(500);
  }
  assert.equal(clicks, 90);
  const ids = (await run([...compose, 'ps', '-q', 'api'], true)).split(/\r?\n/);
  assert.equal(ids.length, 3);
  await run(['stop', '--timeout', '5', ids[0]]);
  const afterStop = await Promise.all(Array.from({ length: 20 }, () => request('/smoke-link')));
  assert.ok(afterStop.every((response) => response.status === 302));
  assert.equal((await request('/api/v1/links/smoke-link', { method: 'DELETE' })).status, 204);
  assert.equal((await request('/smoke-link')).status, 404);
  console.log('PASS: Nginx, 3 API replicas, 2 workers, eventual counts, replica stop, deletion.');
} finally {
  // Only this script's dedicated temporary project and volumes are removed.
  await run([...compose, 'down', '--volumes', '--remove-orphans']);
}
