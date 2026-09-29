// Optional: run integration tests against an isolated cluster using installed PostgreSQL binaries.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(tmpdir());
const directory = mkdtempSync(join(root, 'shortener-pg-test-'));
const data = join(directory, 'data');
const executable = (name) => process.env.PG_BIN
  ? join(process.env.PG_BIN, name + (process.platform === 'win32' ? '.exe' : ''))
  : name;
function run(name, args, options = {}) {
  const result = spawnSync(executable(name), args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(name + ' failed with exit code ' + result.status);
}
const socket = createServer();
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
let started = false;
let safeToRemove = true;
try {
  run('initdb', ['-D', data, '-U', 'test_admin', '--auth=trust', '--encoding=UTF8', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + port, '-w', 'start']);
  started = true;
  const result = spawnSync(process.execPath, ['--test', 'tests/integration/postgres.test.js'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TEST_DATABASE_URL: 'postgresql://test_admin@127.0.0.1:' + port + '/postgres' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); }
    catch (error) { safeToRemove = false; process.exitCode = 1; console.error(error.message); }
  }
  const target = resolve(directory);
  if (safeToRemove && target.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) && basename(target).startsWith('shortener-pg-test-')) {
    rmSync(target, { recursive: true, force: true });
  }
}
