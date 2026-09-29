import { randomBytes } from 'node:crypto';
import { AppError } from '../utils/app-error.js';

export class LinkService {
  constructor(repository, baseUrl, generateCode = () => randomBytes(6).toString('base64url')) {
    this.repository = repository;
    this.baseUrl = baseUrl;
    this.generateCode = generateCode;
  }
  serialize(link) {
    return {
      code: link.code, originalUrl: link.originalUrl, shortUrl: `${this.baseUrl}/${link.code}`,
      clicks: link.clicks, expiresAt: link.expiresAt, lastClickedAt: link.lastClickedAt,
      createdAt: link.createdAt, updatedAt: link.updatedAt,
    };
  }
  async create({ originalUrl, customAlias, expiresAt }) {
    // The database's unique index arbitrates simultaneous creations.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const link = await this.repository.create({ code: customAlias ?? this.generateCode(), originalUrl, expiresAt });
        return this.serialize(link);
      } catch (error) {
        if (error.code !== '23505') throw error;
        if (customAlias) throw new AppError(409, 'ALIAS_TAKEN', 'This alias is already in use');
      }
    }
    throw new AppError(503, 'CODE_UNAVAILABLE', 'Could not allocate a short code. Please retry.');
  }
  async get(code) {
    const link = await this.repository.findByCode(code);
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
    return this.serialize(link);
  }
  async resolve(code, countClick = true) {
    const now = new Date();
    const link = countClick ? await this.repository.recordClick(code, now) : await this.repository.findByCode(code);
    if (link) {
      if (link.expiresAt && new Date(link.expiresAt) <= now) throw new AppError(410, 'LINK_EXPIRED', 'Short link has expired');
      return link.originalUrl;
    }
    const existing = await this.repository.findByCode(code);
    if (existing?.expiresAt && new Date(existing.expiresAt) <= now) throw new AppError(410, 'LINK_EXPIRED', 'Short link has expired');
    throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
  }
  async list(pagination) { return (await this.repository.list(pagination)).map((link) => this.serialize(link)); }
  async delete(code) {
    if (!await this.repository.deleteByCode(code)) throw new AppError(404, 'LINK_NOT_FOUND', 'Short link not found');
  }
}
