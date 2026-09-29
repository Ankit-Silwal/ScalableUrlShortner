import { toLink } from '../models/link.model.js';

export class LinkRepository {
  constructor(pool) { this.pool = pool; }
  async create({ code, originalUrl, expiresAt }) {
    const { rows } = await this.pool.query(
      'INSERT INTO links (code, original_url, expires_at) VALUES ($1, $2, $3) RETURNING *',
      [code, originalUrl, expiresAt ?? null],
    );
    return toLink(rows[0]);
  }
  async findByCode(code) {
    const { rows } = await this.pool.query('SELECT * FROM links WHERE code = $1', [code]);
    return toLink(rows[0]);
  }
  async recordClick(code, now) {
    const { rows } = await this.pool.query(
      `UPDATE links SET clicks = clicks + 1, last_clicked_at = $2, updated_at = $2
       WHERE code = $1 AND (expires_at IS NULL OR expires_at > $2) RETURNING *`,
      [code, now],
    );
    return toLink(rows[0]);
  }
  async list({ page, limit }) {
    const { rows } = await this.pool.query(
      'SELECT * FROM links ORDER BY created_at DESC, code DESC LIMIT $1 OFFSET $2',
      [limit, (page - 1) * limit],
    );
    return rows.map(toLink);
  }
  async deleteByCode(code) {
    const { rows } = await this.pool.query('DELETE FROM links WHERE code = $1 RETURNING *', [code]);
    return toLink(rows[0]);
  }
}
