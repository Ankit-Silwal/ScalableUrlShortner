import pg from 'pg';

export function createPool(config, logger) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
  });
  pool.on('error', (error) => logger?.error({ errorType: error.code }, 'Idle database connection failed'));
  return pool;
}

export async function isDatabaseReady(pool) {
  try {
    await pool.query('SELECT code FROM links LIMIT 0');
    return true;
  } catch {
    return false;
  }
}
