import { spawn } from 'node:child_process';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeDatabase, pool, query } from './db.mjs';

export function normalizeDesiredWorkers(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(2, Math.min(4, parsed)) : 2;
}

export function canStopIdleWorker(node, runningJobs, scaleDownAt, now = Date.now()) {
  if (!node || runningJobs > 0 || node.active_job_id || node.kind !== 'standby') return false;
  const lastSeen = new Date(node.last_seen).getTime();
  return Number.isFinite(lastSeen) && lastSeen >= scaleDownAt && now - lastSeen <= 10000;
}

export async function startSupervisor() {
  await initializeDatabase();
  const lock = await pool.connect();
  const ownership = await lock.query('SELECT pg_try_advisory_lock(740002) AS acquired');
  if (!ownership.rows[0].acquired) {
    console.log('[supervisor] Інший супервізор уже керує резервними процесами.');
    lock.release();
    await pool.end();
    return;
  }
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const runtime = path.join(directory, '.runtime');
  const stopMarker = path.join(runtime, 'stop.request');
  const registry = path.join(runtime, 'supervisor-children.json');
  const children = new Map();
  const restartAfter = new Map();
  let registryWrites = Promise.resolve();
  let stopping = false;
  const stop = () => { stopping = true; };
  lock.on('error', error => { console.error(`[supervisor] Втрачено блокування: ${error.message}`); stopping = true; });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  function persistChildren() {
    registryWrites = registryWrites.catch(() => {}).then(async () => {
      await mkdir(runtime, { recursive: true });
      const snapshot = {
        supervisorPid: process.pid,
        updatedAt: new Date().toISOString(),
        children: [...children.values()].map(state => ({ pid: state.child.pid, workerId: state.workerId, slot: state.slot, startedAt: new Date(state.startedAt).toISOString() })),
      };
      await writeFile(`${registry}.tmp`, JSON.stringify(snapshot, null, 2));
      await rename(`${registry}.tmp`, registry);
    });
    registryWrites.catch(error => console.error(`[supervisor] Реєстр процесів: ${error.message}`));
  }

  function requestDrain(state) {
    if (state.drainRequestedAt) return;
    state.drainRequestedAt = Date.now();
    if (state.child.connected) {
      state.child.send({ type: 'tempo:drain' }, error => {
        if (error) console.error(`[supervisor] ${state.workerId}: ${error.message}`);
      });
    }
    console.log(`[supervisor] ${state.workerId}: очікування завершення активної задачі.`);
  }

  async function spawnSlot(slot) {
    const workerId = `WORKER_${slot}`;
    if (children.has(slot) || Date.now() < (restartAfter.get(slot) || 0)) return;
    const foreign = await query("SELECT id FROM nodes WHERE id = $1 AND last_seen > NOW() - INTERVAL '12 seconds'", [workerId]);
    if (foreign.rowCount) return;
    const child = spawn(process.execPath, [workerPath], {
      cwd: directory,
      env: { ...process.env, WORKER_ID: workerId, WORKER_SLOT: String(slot), TEMPO_SUPERVISED: 'true' },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
      shell: false,
    });
    const state = { child, workerId, slot, startedAt: Date.now(), drainRequestedAt: null };
    children.set(slot, state);
    persistChildren();
    child.on('error', error => console.error(`[supervisor] ${workerId}: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (children.get(slot) === state) children.delete(slot);
      persistChildren();
      restartAfter.set(slot, Date.now() + 2000);
      const endedAt = new Date();
      void query('DELETE FROM nodes WHERE id = $1 AND last_seen <= $2', [workerId, endedAt]).catch(() => {});
      console.log(`[supervisor] ${workerId}: процес завершено (${signal || code || 0}).`);
    });
    console.log(`[supervisor] Запущено ${workerId}, PID ${child.pid ?? 'очікується'}.`);
  }

  async function retireSlot(state, shutdown = false) {
    requestDrain(state);
    if (state.child.exitCode !== null || state.child.signalCode !== null) return;
    const [{ rows: nodes }, { rows: active }] = await Promise.all([
      query('SELECT * FROM nodes WHERE id = $1', [state.workerId]),
      query("SELECT COUNT(*)::integer AS count FROM jobs WHERE worker_id = $1 AND status = 'running'", [state.workerId]),
    ]);
    if (canStopIdleWorker(nodes[0], active[0].count, state.drainRequestedAt)) {
      state.child.kill();
    } else if (shutdown && Date.now() - state.drainRequestedAt > 180000) {
      await query(`
        UPDATE jobs SET status = 'failed', cancel_requested = true, completed_at = NOW(),
          stage = 'Завершення супервізора: перевищено час очікування',
          error = 'Обчислювальний процес не завершився за 180 секунд після запиту зупинки.'
        WHERE worker_id = $1 AND status = 'running'
      `, [state.workerId]);
      state.child.kill();
    }
  }

  console.log('[supervisor] Резервні Node.js-процеси WORKER_3/4 запускаються за попитом PostgreSQL.');
  persistChildren();
  try {
    while (!stopping) {
      try {
        const requested = await access(stopMarker).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (requested) { stopping = true; break; }
        const setting = await query("SELECT value FROM settings WHERE key = 'desired_workers'");
        const desired = normalizeDesiredWorkers(setting.rows[0]?.value);
        for (const slot of [3, 4]) {
          const state = children.get(slot);
          if (slot <= desired && !state) await spawnSlot(slot);
          if (slot > desired && state) await retireSlot(state);
        }
      } catch (error) {
        console.error(`[supervisor] ${error.message}`);
      }
      await sleep(750);
    }
  } finally {
    for (const state of children.values()) requestDrain(state);
    const shutdownStarted = Date.now();
    while (children.size) {
      for (const state of children.values()) {
        try {
          await retireSlot(state, true);
        } catch (error) {
          console.error(`[supervisor] Очікування ${state.workerId}: ${error.message}`);
          if (Date.now() - shutdownStarted > 180000) state.child.kill();
        }
      }
      if (children.size) await sleep(500);
    }
    persistChildren();
    await registryWrites.catch(() => {});
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lock.query('SELECT pg_advisory_unlock(740002)').catch(() => {});
    lock.release();
    await pool.end();
    console.log('[supervisor] Усі власні резервні процеси зупинено.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSupervisor().catch(error => { console.error(error); process.exitCode = 1; });
}
