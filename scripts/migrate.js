import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/config/database.js';
import { migrate } from '../src/config/migrations.js';

let pool;
try {
  pool = createPool(loadConfig());
  await migrate(pool);
  console.log('Database migrations applied.');
} catch (error) {
  console.error('Migration failed. Check environment and database connectivity.', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
