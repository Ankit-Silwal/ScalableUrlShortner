import { randomBytes } from 'node:crypto';
import { AppError } from '../utils/app-error.js';
import { encodeCursor, decodeCursor } from '../utils/cursor.js';

export class LinkService {
  constructor(repository, baseUrl, generateCode = () => randomBytes(9).toString('base64url'), options = {}) {
    this.repository = repository;
    this.baseUrl = baseUrl;
    this.generateCode = generateCode;
    this.cache = options.cache;
    this.analytics = options.analytics;
    this.metrics = options.metrics;
    this.inflight = new Map();
  }
  serialize(link) {
    return {
      code: link.code, originalUrl: link.originalUrl, shortUrl: `${this.baseUrl}/${link.code}`,
      clicks: link.clicks, expiresAt: link.expiresAt, lastClickedAt: link.lastClickedAt,
      createdAt: link.createdAt, updatedAt: link.updatedAt,
    };
  }
  async cacheOperation(operation) {
    try { return await operation(); }
    catch { this.metrics?.cache.inc({ result: 'error' }); return undefined; }
  }
  async create({ originalUrl, customAlias, expiresAt }) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const link = await this.repository.create({ code: customAlias ?? this.generateCode(), originalUrl, expiresAt });
        if (this.cache) await this.cacheOperation(() => this.cache.created(link));
        return this.serialize(link);
      } catch (error) {
        if (error.code !== '23505') throw error;
        if (customAlias) throw new AppError(409, 'ALIAS_TAKEN', 'This alias is already in use or reserved');
      }
    }
    throw new AppError(503, 'CODE_UNAVAILABLE', 'Could not allocate a short code. Please retry.');
  }
  async get(code) {
    const link = await this.repository.findByCode(code);
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
    return this.serialize(link);
  }
  async lookup(code) {
    if (this.cache) {
      const cached = await this.cacheOperation(() => this.cache.get(code));
      if (cached !== undefined) {
        this.metrics?.cache.inc({ result: 'hit' });
        return cached;
      }
      this.metrics?.cache.inc({ result: 'miss' });
    }
    // Coalesce a burst of misses for the same code within each API instance.
    if (this.inflight.has(code)) return this.inflight.get(code);
    const pending = (async () => {
      const link = await this.repository.findByCode(code);
      if (this.cache) await this.cacheOperation(() => this.cache.remember(code, link));
      return link;
    })();
    this.inflight.set(code, pending);
    try { return await pending; }
    finally { this.inflight.delete(code); }
  }
  async resolve(code, countClick = true) {
    const now = new Date();
    if (this.analytics || !countClick) {
      const link = await this.lookup(code);
      if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
      if (link.expiresAt && new Date(link.expiresAt) <= now) throw new AppError(410, 'LINK_EXPIRED', 'Short link has expired');
      if (countClick) await this.analytics.record(code, now);
      return link.originalUrl;
    }
    // Development without Redis retains synchronous counting.
    const link = await this.repository.recordClick(code, now);
    if (link) return link.originalUrl;
    const existing = await this.repository.findByCode(code);
    if (existing?.expiresAt && new Date(existing.expiresAt) <= now) throw new AppError(410, 'LINK_EXPIRED', 'Short link has expired');
    throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
  }
  async list({ limit, cursor }) {
    const rows = await this.repository.list({ limit: limit + 1, after: decodeCursor(cursor) });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      data: page.map((link) => this.serialize(link)),
      pagination: { limit, nextCursor: hasMore ? encodeCursor(page.at(-1)) : null },
    };
  }
  async delete(code) {
    if (!await this.repository.deleteByCode(code)) throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
    if (this.cache) await this.cacheOperation(() => this.cache.deleted(code));
  }
}
