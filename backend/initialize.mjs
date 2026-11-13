import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { initializeDatabase, query, pool } from './db.mjs';
import { hashPassword } from './auth.mjs';
import { config } from './config.mjs';

export async function seedDemo() {
  if (!config.seedDemo) return;
  const passwordHash = await hashPassword('TempoDemo2026!');
  for (const [name, email, role] of [['Адміністратор','admin@tempo.local','admin'],['Студент','student@tempo.local','user']]) {
    await query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT(email) DO NOTHING', [randomUUID(),name,email,passwordHash,role]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await initializeDatabase();
    await seedDemo();
    console.log('Tempo database is ready.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
