import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

test('a real worker hard-stops CPU work after one second and processes the next job', { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 }, async () => {
  const { Pool } = await import('pg');
  const schema = `tempo_timeout_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  let scoped;
  let child;
  let logs = '';
  const id = randomUUID();
  const nextId = randomUUID();
  const userId = randomUUID();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    scoped = new Pool({ connectionString: url.href });
    await scoped.query(await readFile(new URL('../server/schema.sql', import.meta.url), 'utf8'));
    await scoped.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Timeout test',$2,'not-used')", [userId, `${userId}@timeout.local`]);
    const input = {
      name: 'Hard timeout test',
      resources: Array.from({ length: 4 }, (_, index) => ({ id: `r${index}`, name: `Resource ${index}` })),
      tasks: Array.from({ length: 80 }, (_, index) => ({ id: `t${index}`, name: `Task ${index}`, duration: 1 + index % 9, deadline: 20 + index % 30, dependencies: index > 4 && index % 3 === 0 ? [`t${index - 3}`] : [] })),
      iterations: 2000000, seed: 42,
    };
    await scoped.query('INSERT INTO jobs(id,user_id,name,input) VALUES($1,$2,$3,$4::jsonb)', [id, userId, input.name, JSON.stringify(input)]);
    child = spawn(process.execPath, [fileURLToPath(new URL('../server/worker.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: url.href, TASK_TIMEOUT_SECONDS: '1', WORKER_ID: `TIMEOUT_${userId}`, WORKER_SLOT: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false,
    });
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    const waitFor = async (jobId, expected) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const { rows } = await scoped.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
        if (rows[0]?.status === expected) return rows[0];
        if (child.exitCode !== null) throw new Error(`Worker exited: ${logs}`);
        await sleep(100);
      }
      throw new Error(`Job did not become ${expected}: ${logs}`);
    };
    const failed = await waitFor(id, 'failed');
    assert.match(failed.error, /ліміт виконання 1 с/);
    assert.match(failed.stage, /ліміт часу/);
    assert.ok(failed.execution_ms >= 900 && failed.execution_ms < 5000, `Execution time ${failed.execution_ms}ms`);
    assert.equal(failed.result, null);
    assert.equal(failed.attempts, 1);
    assert.ok(failed.progress < 100);
    const small = { ...input, name: 'After timeout', tasks: input.tasks.slice(0, 4), iterations: 1000 };
    await scoped.query('INSERT INTO jobs(id,user_id,name,input) VALUES($1,$2,$3,$4::jsonb)', [nextId, userId, small.name, JSON.stringify(small)]);
    const completed = await waitFor(nextId, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.result.iterations, 1000);
    const original = await scoped.query('SELECT status,result FROM jobs WHERE id=$1', [id]);
    assert.equal(original.rows[0].status, 'failed');
    assert.equal(original.rows[0].result, null);
  } finally {
    if (child && child.exitCode === null) {
      if (child.connected) child.send({ type: 'tempo:drain' });
      const until = Date.now() + 3000;
      while (child.exitCode === null && Date.now() < until) await sleep(50);
      if (child.exitCode === null) child.kill();
    }
    await scoped?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
