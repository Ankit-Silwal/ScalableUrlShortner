import pg from 'pg';

export function createPool(config, logger) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_QUERY_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    statement_timeout: config.DB_QUERY_TIMEOUT_MS,
    query_timeout: config.DB_QUERY_TIMEOUT_MS + 500,
  });
  pool.on('error', (error) => logger?.error({ errorType: error.code }, 'Idle database connection failed'));
  return pool;
}

export async function isDatabaseReady(pool) {
  try {
    await pool.query('SELECT code, deleted_at FROM links, analytics_checkpoints LIMIT 0');
    return true;
  } catch {
    return false;
  }
}
