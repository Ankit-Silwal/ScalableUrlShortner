import { CLICK_PARTITIONS, streamFor } from '../infrastructure/click-stream.js';

export class AnalyticsWorker {
  constructor({ pool, redis, prefix, batchSize = 500, metrics }) {
    Object.assign(this, { pool, redis, prefix, batchSize, metrics });
  }
  async initialize() {
    const streams = Array.from({ length: CLICK_PARTITIONS }, (_, index) => streamFor(this.prefix, index));
    await this.pool.query(
      'INSERT INTO analytics_checkpoints (stream) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [streams],
    );
  }
  async processPartition(partition) {
    const stream = streamFor(this.prefix, partition);
    const client = await this.pool.connect();
    let lastId;
    let count = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT last_id FROM analytics_checkpoints WHERE stream = $1 FOR UPDATE SKIP LOCKED', [stream],
      );
      if (!rows.length) { await client.query('ROLLBACK'); return 0; }
      lastId = rows[0].last_id;
      const entries = await this.redis.xrange(stream, '(' + lastId, '+', 'COUNT', this.batchSize);
      if (entries.length) {
        const events = entries.map(([, fields]) => {
          const values = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
          if (!/^[A-Za-z0-9_-]{4,32}$/.test(values.code) || !Number.isFinite(Date.parse(values.at))) {
            throw new Error('Invalid analytics event; repair the stream before resuming');
          }
          return { code: values.code, at: values.at };
        });
        await client.query(`
          UPDATE links AS link SET
            clicks = link.clicks + totals.count,
            last_clicked_at = GREATEST(link.last_clicked_at, totals.last_at),
            updated_at = NOW()
          FROM (
            SELECT code, COUNT(*) AS count, MAX(at::timestamptz) AS last_at
            FROM jsonb_to_recordset($1::jsonb) AS event(code text, at text)
            GROUP BY code
          ) AS totals
          WHERE link.code = totals.code AND link.deleted_at IS NULL
        `, [JSON.stringify(events)]);
        lastId = entries.at(-1)[0];
        await client.query('UPDATE analytics_checkpoints SET last_id = $2, updated_at = NOW() WHERE stream = $1', [stream, lastId]);
        count = entries.length;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    // Only remove IDs below the committed checkpoint. Crash here is safe: replay reads strictly after it.
    // Even an older concurrent trim cannot remove a newer uncommitted event.
    if (lastId !== '0-0') await this.redis.xtrim(stream, 'MINID', lastId);
    if (count) {
      this.metrics?.batches.inc();
      this.metrics?.applied.inc(count);
    }
    const oldest = await this.redis.xrange(stream, '(' + lastId, '+', 'COUNT', 1);
    this.metrics?.lag.set({ partition: String(partition) }, oldest.length ? Math.max(0, (Date.now() - Number(oldest[0][0].split('-')[0])) / 1000) : 0);
    return count;
  }
  async tick() {
    let processed = 0;
    // Vary order so multiple workers do not repeatedly compete for the same first shard.
    const start = Math.floor(Math.random() * CLICK_PARTITIONS);
    for (let index = 0; index < CLICK_PARTITIONS; index++) {
      processed += await this.processPartition((start + index) % CLICK_PARTITIONS);
    }
    return processed;
  }
}
