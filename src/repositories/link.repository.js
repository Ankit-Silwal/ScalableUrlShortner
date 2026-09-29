import { toLink } from '../models/link.model.js';

// Preserve PostgreSQL microseconds in cursors; JavaScript Date truncates to milliseconds.
const columns = `*, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_timestamp`;

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
    const { rows } = await this.pool.query('SELECT * FROM links WHERE code = $1 AND deleted_at IS NULL', [code]);
    return toLink(rows[0]);
  }
  async recordClick(code, now) {
    const { rows } = await this.pool.query(
      `UPDATE links SET clicks = clicks + 1, last_clicked_at = $2, updated_at = $2
       WHERE code = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > $2) RETURNING *`,
      [code, now],
    );
    return toLink(rows[0]);
  }
  async list({ limit, after }) {
    const { rows } = after
      ? await this.pool.query(
        `SELECT ${columns} FROM links WHERE deleted_at IS NULL AND (created_at, code) < ($1::timestamptz, $2)
         ORDER BY created_at DESC, code DESC LIMIT $3`, [after.createdAt, after.code, limit],
      )
      : await this.pool.query(
        `SELECT ${columns} FROM links WHERE deleted_at IS NULL ORDER BY created_at DESC, code DESC LIMIT $1`, [limit],
      );
    return rows.map(toLink);
  }
  async deleteByCode(code) {
    const { rows } = await this.pool.query(
      'UPDATE links SET deleted_at = NOW(), updated_at = NOW() WHERE code = $1 AND deleted_at IS NULL RETURNING *', [code],
    );
    return toLink(rows[0]);
  }
}
