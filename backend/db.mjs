import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { config } from './config.mjs';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
pool.on('error', error => console.error('PostgreSQL pool:', error.message));
export const query = (text, params) => pool.query(text, params);

export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(740001)');
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  } finally {
    await client.query('SELECT pg_advisory_unlock(740001)').catch(() => {});
    client.release();
  }
}
