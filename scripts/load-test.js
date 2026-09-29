import http from 'node:http';
import https from 'node:https';
import { createHistogram, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export async function loadTest({ origins, durationSeconds = 15, concurrency = 32, pathFor = () => '/', expectedStatus = 302 }) {
  if (!origins.length || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) throw new Error('Invalid load-test configuration');
  const agents = new Map(origins.map((origin) => [origin, new (origin.startsWith('https:') ? https.Agent : http.Agent)({
    keepAlive: true, maxSockets: concurrency,
  })]));
  const histogram = createHistogram();
  const statuses = {};
  let errors = 0;
  let sequence = 0;
  let completed = 0;
  const start = performance.now();
  const deadline = start + durationSeconds * 1000;
  const request = () => new Promise((resolve) => {
    const id = sequence++;
    const origin = origins[id % origins.length];
    const began = performance.now();
    const transport = origin.startsWith('https:') ? https : http;
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      histogram.record(Math.max(1, Math.round((performance.now() - began) * 1e6)));
      if (status) { statuses[status] = (statuses[status] ?? 0) + 1; completed++; }
      else errors++;
      resolve();
    };
    const req = transport.get(origin + pathFor(id), { agent: agents.get(origin) }, (res) => {
      res.resume();
      res.on('end', () => finish(res.statusCode));
      res.on('error', () => finish());
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', () => finish());
  });
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) await request();
    }));
  } finally { for (const agent of agents.values()) agent.destroy(); }
  const elapsed = (performance.now() - start) / 1000;
  return {
    durationSeconds: Number(elapsed.toFixed(2)), concurrency, completed, errors, statuses,
    requestsPerSecond: Number((completed / elapsed).toFixed(2)),
    expectedStatus, unexpectedResponses: completed - (statuses[expectedStatus] ?? 0),
    latencyMs: { p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6 },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL(process.env.LOAD_URL ?? 'http://localhost:3000/example');
  const result = await loadTest({
    origins: [target.origin],
    durationSeconds: Number(process.env.LOAD_DURATION_SECONDS ?? 15),
    concurrency: Number(process.env.LOAD_CONCURRENCY ?? 32),
    pathFor: () => target.pathname + target.search,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.errors || result.unexpectedResponses) process.exitCode = 1;
}
