import { Worker } from 'node:worker_threads';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.mjs';
import { initializeDatabase, pool, query } from './db.mjs';

export async function claimNextJob(workerId, execute = query) {
  const claimed = await execute(`
    UPDATE jobs AS job
    SET status = 'running', progress = 1, stage = 'Воркер отримав задачу',
        worker_id = $1, started_at = NOW(), heartbeat_at = NOW(), attempts = attempts + 1
    FROM (
      SELECT id FROM jobs
      WHERE status = 'queued' AND cancel_requested = false
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ) AS next
    WHERE job.id = next.id
    RETURNING job.*
  `, [workerId]);
  return claimed.rows[0] ?? null;
}

export async function startWorker() {
  await initializeDatabase();
  const workerId = process.env.WORKER_ID || config.workerId || 'worker-1';
  const slot = Number(process.env.WORKER_SLOT || 1);
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) throw new Error('WORKER_SLOT має бути від 1 до 4.');
  let stopping = false;
  let activeJobId = null;
  let enabled = slot <= 2;
  let heartbeatBusy = false;
  let lastCpu = process.cpuUsage();
  let lastCpuAt = performance.now();
  const requestShutdown = () => { stopping = true; };
  const requestDrain = message => { if (message?.type === 'tempo:drain') stopping = true; };
  process.on('SIGTERM', requestShutdown);
  process.on('SIGINT', requestShutdown);
  process.on('message', requestDrain);

  async function heartbeat() {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const now = performance.now();
      const currentCpu = process.cpuUsage();
      const cpu = Math.max(0, (currentCpu.user - lastCpu.user + currentCpu.system - lastCpu.system) / ((now - lastCpuAt) * 1000) * 100);
      lastCpu = currentCpu;
      lastCpuAt = now;
      await query(`
        INSERT INTO nodes (id, kind, active_job_id, last_seen, cpu_percent, memory_mb)
        VALUES ($1, $2, $3, NOW(), $4, $5)
        ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, active_job_id = EXCLUDED.active_job_id,
          last_seen = NOW(), cpu_percent = EXCLUDED.cpu_percent, memory_mb = EXCLUDED.memory_mb
      `, [workerId, enabled || activeJobId ? 'worker' : 'standby', activeJobId, Math.round(cpu * 10) / 10, Math.round(process.memoryUsage().rss / 1048576)]);
    } catch (error) {
      console.error(`[${workerId}] heartbeat: ${error.message}`);
    } finally {
      heartbeatBusy = false;
    }
  }

  async function executeJob(job) {
    activeJobId = job.id;
    await heartbeat();
    const began = performance.now();
    const thread = new Worker(new URL('./compute-thread.mjs', import.meta.url), { workerData: { input: job.input } });
    let latestProgress = { progress: 2, stage: 'Підготовка оптимізатора' };
    let interrupted = null;
    let controlBusy = false;
    let exited = false;
    let failCompute;
    const computation = new Promise((resolve, reject) => {
      failCompute = reject;
      thread.on('message', message => {
        if (message.type === 'progress') latestProgress = { progress: Math.max(2, Math.min(99, Number(message.progress) || 2)), stage: String(message.stage).slice(0, 500) };
        if (message.type === 'result') resolve(message.result);
        if (message.type === 'error') reject(new Error(message.error));
      });
      thread.on('error', reject);
      thread.on('exit', code => {
        exited = true;
        if (code !== 0 || interrupted) reject(new Error(interrupted || `Обчислювальний потік завершився з кодом ${code}.`));
      });
    });
    computation.catch(() => {});
    const terminate = reason => {
      if (interrupted) return;
      interrupted = reason;
      failCompute(new Error(reason));
      void thread.terminate();
    };

    async function synchronize() {
      if (controlBusy || exited) return;
      controlBusy = true;
      try {
        const state = await query(`
          UPDATE jobs SET progress = $3, stage = $4, heartbeat_at = NOW()
          WHERE id = $1 AND worker_id = $2 AND status = 'running' AND attempts = $5
          RETURNING cancel_requested
        `, [job.id, workerId, latestProgress.progress, latestProgress.stage, job.attempts]);
        if (state.rowCount === 0 || state.rows[0].cancel_requested) terminate('TASK_CANCELLED');
      } catch (error) {
        console.error(`[${workerId}] progress: ${error.message}`);
      } finally {
        controlBusy = false;
      }
    }

    const progressTimer = setInterval(() => void synchronize(), 400);
    const timeoutTimer = setTimeout(() => terminate('TASK_TIMEOUT'), (config.timeoutSeconds || 120) * 1000);
    progressTimer.unref();
    timeoutTimer.unref();
    console.log(`[${workerId}] Початок ${job.id}: ${job.name}`);
    try {
      const result = await computation;
      const elapsed = Math.round(performance.now() - began);
      const completed = await query(`
        UPDATE jobs SET status = 'completed', progress = 100, stage = 'Оптимізований розклад готовий',
          result = $3::jsonb, execution_ms = $4, completed_at = NOW(), heartbeat_at = NOW()
        WHERE id = $1 AND worker_id = $2 AND status = 'running' AND cancel_requested = false AND attempts = $5
        RETURNING id
      `, [job.id, workerId, JSON.stringify(result), elapsed, job.attempts]);
      if (!completed.rowCount) {
        await query(`UPDATE jobs SET status = 'cancelled', stage = 'Скасовано користувачем', completed_at = NOW(), execution_ms = $3
          WHERE id = $1 AND worker_id = $2 AND status = 'running' AND cancel_requested = true AND attempts = $4`, [job.id, workerId, elapsed, job.attempts]);
      } else {
        console.log(`[${workerId}] Завершено ${job.id} за ${elapsed} мс; покращення ${result.improvementPercent}%`);
      }
    } catch (error) {
      const elapsed = Math.round(performance.now() - began);
      const cancelled = interrupted === 'TASK_CANCELLED' || error.message === 'TASK_CANCELLED';
      const stage = cancelled ? 'Скасовано користувачем' : error.message === 'TASK_TIMEOUT' ? 'Перевищено ліміт часу' : 'Помилка обчислення';
      const message = error.message === 'TASK_TIMEOUT' ? `Перевищено ліміт виконання ${(config.timeoutSeconds || 120)} с. Обчислювальний потік зупинено.` : error.message;
      await query(`
        UPDATE jobs SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE $3 END,
          stage = CASE WHEN cancel_requested THEN 'Скасовано користувачем' ELSE $4 END,
          error = CASE WHEN cancel_requested OR $3 = 'cancelled' THEN NULL ELSE $5 END,
          execution_ms = $6, completed_at = NOW(), heartbeat_at = NOW()
        WHERE id = $1 AND worker_id = $2 AND status = 'running' AND attempts = $7
      `, [job.id, workerId, cancelled ? 'cancelled' : 'failed', stage, message, elapsed, job.attempts]);
      console.log(`[${workerId}] ${stage}: ${job.id}`);
    } finally {
      clearInterval(progressTimer);
      clearTimeout(timeoutTimer);
      await thread.terminate();
      activeJobId = null;
      await heartbeat();
    }
  }

  const nodeTimer = setInterval(() => void heartbeat(), 2000);
  nodeTimer.unref();
  await heartbeat();
  console.log(`[${workerId}] Готовий. Слот ${slot}, PostgreSQL SKIP LOCKED.`);
  try {
    while (!stopping) {
      try {
        const requested = await access(new URL('../.runtime/stop.request', import.meta.url)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (requested) { stopping = true; break; }
        const desiredRow = await query("SELECT value FROM settings WHERE key = 'desired_workers'");
        const desired = Math.max(2, Math.min(4, Number(desiredRow.rows[0]?.value) || 2));
        enabled = slot <= desired;
        const job = enabled ? await claimNextJob(workerId) : null;
        if (job) await executeJob(job);
        else await sleep(500);
      } catch (error) {
        console.error(`[${workerId}] ${error.message}`);
        await sleep(1500);
      }
    }
  } finally {
    clearInterval(nodeTimer);
    process.off('SIGTERM', requestShutdown);
    process.off('SIGINT', requestShutdown);
    process.off('message', requestDrain);
    await query('DELETE FROM nodes WHERE id = $1', [workerId]).catch(() => {});
    await pool.end();
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().catch(error => { console.error(error); process.exitCode = 1; });
}
