import { once } from 'node:events';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';

export const config = loadConfig({
  NODE_ENV: 'test', BASE_URL: 'https://sho.rt',
  DATABASE_URL: 'postgresql://localhost/shortener_test',
  API_KEY: 'test-key-that-is-at-least-32-characters',
  API_RATE_LIMIT: 1000, REDIRECT_RATE_LIMIT: 1000,
});

export class MemoryRepository {
  links = new Map();
  async create(data) {
    if (this.links.has(data.code)) throw Object.assign(new Error('Duplicate'), { code: '23505' });
    const link = { clicks: 0, expiresAt: null, lastClickedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
    this.links.set(data.code, link);
    return link;
  }
  async findByCode(code) { const link = this.links.get(code); return link?.deleted ? null : link ?? null; }
  async recordClick(code, now) {
    const link = this.links.get(code);
    if (!link || link.deleted || (link.expiresAt && link.expiresAt <= now)) return null;
    link.clicks++;
    link.lastClickedAt = now;
    return link;
  }
  async list({ limit, after }) { return [...this.links.values()].filter((link) => !link.deleted).sort((a,b) => b.createdAt - a.createdAt || b.code.localeCompare(a.code)).filter((link) => !after || link.createdAt < new Date(after.createdAt) || (+link.createdAt === +new Date(after.createdAt) && link.code < after.code)).slice(0, limit); }
  async deleteByCode(code) {
    const link = this.links.get(code);
    if (link?.deleted) return null;
    if (link) link.deleted = true;
    return link;
  }
}

export async function fixture(t, options = {}) {
  const repository = options.repository ?? new MemoryRepository();
  const app = createApp({ config: { ...config, ...options.config }, repository, logger: pino({ level: 'silent' }), isReady: options.isReady, redis: options.redis, cache: options.cache, analytics: options.analytics, metrics: options.metrics });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, { body, rawBody, auth = true, headers, ...init } = {}) => fetch(base + path, {
    ...init, redirect: 'manual',
    headers: { ...(auth ? { 'x-api-key': config.API_KEY } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { request, repository, base };
}
