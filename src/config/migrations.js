import { readdir, readFile } from 'node:fs/promises';
const directory = new URL('../../migrations/', import.meta.url);

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize simultaneous migration processes on this database.
    await client.query('SELECT pg_advisory_xact_lock(83017294)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
