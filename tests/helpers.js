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
  async findByCode(code) { return this.links.get(code) ?? null; }
  async recordClick(code, now) {
    const link = this.links.get(code);
    if (!link || (link.expiresAt && link.expiresAt <= now)) return null;
    link.clicks++;
    link.lastClickedAt = now;
    return link;
  }
  async list({ page, limit }) { return [...this.links.values()].slice((page - 1) * limit, page * limit); }
  async deleteByCode(code) {
    const link = this.links.get(code);
    this.links.delete(code);
    return link;
  }
}

export async function fixture(t, options = {}) {
  const repository = options.repository ?? new MemoryRepository();
  const app = createApp({ config: { ...config, ...options.config }, repository, logger: pino({ level: 'silent' }), isReady: options.isReady });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, { body, rawBody, auth = true, headers, ...init } = {}) => fetch(base + path, {
    ...init, redirect: 'manual',
    headers: { ...(auth ? { 'x-api-key': config.API_KEY } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { request, repository };
}
