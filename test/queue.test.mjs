import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

test('PostgreSQL atomically assigns every queued job once and skips cancelled work', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = await import('pg');
  const { claimNextJob } = await import('../backend/worker.mjs');
  const schema = `tempo_queue_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let scoped;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    scoped = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema} -c statement_timeout=3000`, max: 12 });
    await scoped.query(`CREATE TABLE jobs (
      id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'queued', progress integer DEFAULT 0,
      stage text, worker_id text, started_at timestamptz, heartbeat_at timestamptz,
      attempts integer NOT NULL DEFAULT 0, cancel_requested boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
    const ids = Array.from({ length: 24 }, () => randomUUID());
    for (const id of ids) await scoped.query('INSERT INTO jobs (id) VALUES ($1)', [id]);
    const cancelledId = randomUUID();
    await scoped.query('INSERT INTO jobs (id, cancel_requested) VALUES ($1, true)', [cancelledId]);
    const execute = (text, parameters) => scoped.query(text, parameters);
    await scoped.query("UPDATE jobs SET created_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [ids[0]]);
    const locker = await scoped.connect();
    let whileLocked;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [ids[0]]);
      whileLocked = await claimNextJob('skip-locked-worker', execute);
      assert.ok(whileLocked);
      assert.notEqual(whileLocked.id, ids[0]);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    const claims = await Promise.all(Array.from({ length: 40 }, (_, index) => claimNextJob(`test-worker-${index}`, execute)));
    const taken = [whileLocked, ...claims.filter(Boolean)];
    assert.equal(taken.length, ids.length);
    assert.equal(new Set(taken.map(job => job.id)).size, ids.length);
    assert.ok(taken.every(job => job.status === 'running' && job.attempts === 1 && job.worker_id));
    assert.ok(taken.every(job => job.id !== cancelledId));
    assert.equal(await claimNextJob('extra', execute), null);
    const cancelled = await scoped.query('SELECT status FROM jobs WHERE id = $1', [cancelledId]);
    assert.equal(cancelled.rows[0].status, 'queued');
  } finally {
    await scoped?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
