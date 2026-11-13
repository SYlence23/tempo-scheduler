import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { initializeDatabase, pool, query } from './db.mjs';

export function scaleDecision({ queued, running, current, idleSince, now }) {
  if (queued > 0) return { desired: Math.max(current, Math.max(2, Math.min(4, running + queued))), idleSince: null };
  if (running > 2 || current === 2) return { desired: current, idleSince: null };
  const idle = idleSince ?? now;
  return now - idle >= 20000 ? { desired: 2, idleSince: null } : { desired: current, idleSince: idle };
}

export async function startAutoscaler() {
  await initializeDatabase();
  let stopping = false;
  let idleSince = null;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log('[autoscaler] PostgreSQL, межі 2–4 воркери.');
  try {
    while (!stopping) {
      try {
        await query(`
          UPDATE jobs SET status = 'cancelled', stage = 'Скасовано користувачем', completed_at = NOW()
          WHERE status = 'running' AND cancel_requested = true AND heartbeat_at < NOW() - INTERVAL '25 seconds'
        `);
        const recovered = await query(`
          UPDATE jobs SET status = CASE WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,
            stage = CASE WHEN attempts < 3 THEN 'Повторно в черзі після втрати воркера' ELSE 'Втрачено з’єднання з воркером' END,
            worker_id = NULL, progress = 0, heartbeat_at = NULL,
            error = CASE WHEN attempts >= 3 THEN 'Воркер не відповів після трьох спроб.' ELSE NULL END,
            completed_at = CASE WHEN attempts >= 3 THEN NOW() ELSE NULL END
          WHERE status = 'running' AND cancel_requested = false AND heartbeat_at < NOW() - INTERVAL '25 seconds'
          RETURNING id
        `);
        if (recovered.rowCount) console.log(`[autoscaler] Відновлено задач: ${recovered.rowCount}`);
        const counts = await query("SELECT status, COUNT(*)::integer AS count FROM jobs WHERE status IN ('queued', 'running') GROUP BY status");
        const quantities = Object.fromEntries(counts.rows.map(row => [row.status, row.count]));
        const setting = await query("SELECT value FROM settings WHERE key = 'desired_workers'");
        const current = Math.max(2, Math.min(4, Number(setting.rows[0]?.value) || 2));
        const decision = scaleDecision({ queued: quantities.queued || 0, running: quantities.running || 0, current, idleSince, now: Date.now() });
        idleSince = decision.idleSince;
        await query("INSERT INTO settings (key, value) VALUES ('desired_workers', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(decision.desired)]);
        await query("DELETE FROM nodes WHERE last_seen < NOW() - INTERVAL '1 hour'");
        if (decision.desired !== current) console.log(`[autoscaler] Воркери: ${current} → ${decision.desired}`);
      } catch (error) {
        console.error(`[autoscaler] ${error.message}`);
      }
      await sleep(2000);
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAutoscaler().catch(error => { console.error(error); process.exitCode = 1; });
}
