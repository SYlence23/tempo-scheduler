import assert from 'node:assert/strict';
import test from 'node:test';
import { canStopIdleWorker, normalizeDesiredWorkers } from '../backend/supervisor.mjs';

test('supervisor only permits bounded standby capacity', () => {
  assert.equal(normalizeDesiredWorkers(undefined), 2);
  assert.equal(normalizeDesiredWorkers(1), 2);
  assert.equal(normalizeDesiredWorkers(9), 4);
  assert.equal(normalizeDesiredWorkers('3'), 3);
  assert.equal(normalizeDesiredWorkers(3.5), 2);
});

test('supervisor refuses to kill active, stale or not-yet-drained workers', () => {
  const now = 1700000000000;
  const idle = { kind: 'standby', active_job_id: null, last_seen: new Date(now - 1000) };
  assert.equal(canStopIdleWorker(idle, 0, now - 2000, now), true);
  assert.equal(canStopIdleWorker(idle, 1, now - 2000, now), false);
  assert.equal(canStopIdleWorker({ ...idle, active_job_id: 'job' }, 0, now - 2000, now), false);
  assert.equal(canStopIdleWorker({ ...idle, kind: 'worker' }, 0, now - 2000, now), false);
  assert.equal(canStopIdleWorker(idle, 0, now - 500, now), false);
  assert.equal(canStopIdleWorker({ ...idle, last_seen: new Date(now - 20000) }, 0, now - 30000, now), false);
  assert.equal(canStopIdleWorker(null, 0, now - 2000, now), false);
});
