import assert from 'node:assert/strict';
import test from 'node:test';
import { optimize, validateInput } from '../server/optimizer.mjs';

const fixture = () => ({
  name: 'Спринт', resources: [{ id: 'a', name: 'Анна' }, { id: 'b', name: 'Богдан' }],
  tasks: [
    { id: 'design', name: 'Дизайн', duration: 3, deadline: 5, dependencies: [], eligibleResources: ['a'] },
    { id: 'api', name: 'API', duration: 4, deadline: 6, dependencies: [] },
    { id: 'ui', name: 'UI', duration: 2, deadline: 7, dependencies: ['design'] },
    { id: 'qa', name: 'Тестування', duration: 2, deadline: 9, dependencies: ['api', 'ui'] },
  ], iterations: 5000, seed: 21,
});

test('rejects cyclic dependencies, unknown references and excessive workload', () => {
  const cyclic = fixture();
  cyclic.tasks[0].dependencies = ['qa'];
  assert.throws(() => validateInput(cyclic), /цикл/);
  const unknown = fixture();
  unknown.tasks[1].dependencies = ['missing'];
  assert.throws(() => validateInput(unknown), /невідомої/);
  assert.throws(() => validateInput({ ...fixture(), iterations: 2000001 }), /ітерацій/);
  const badResource = fixture();
  badResource.tasks[0].eligibleResources = ['missing'];
  assert.throws(() => validateInput(badResource), /невідомого виконавця/);
});

test('optimized schedule respects dependencies, resource exclusivity and eligibility', async () => {
  const input = fixture();
  const result = await optimize(input);
  assert.ok(result.optimized.score <= result.baseline.score + 0.001);
  assert.equal(result.optimized.schedule.length, input.tasks.length);
  assert.equal(result.iterations, input.iterations);
  const byId = new Map(result.optimized.schedule.map(task => [task.taskId, task]));
  for (const task of input.tasks) {
    const actual = byId.get(task.id);
    assert.equal(actual.end - actual.start, task.duration);
    for (const dependency of task.dependencies) assert.ok(actual.start >= byId.get(dependency).end);
    if (task.eligibleResources) assert.ok(task.eligibleResources.includes(actual.resourceId));
  }
  for (const resource of input.resources) {
    const tasks = result.optimized.schedule.filter(task => task.resourceId === resource.id).sort((left, right) => left.start - right.start);
    for (let index = 1; index < tasks.length; index++) assert.ok(tasks[index].start >= tasks[index - 1].end);
  }
});

test('a fixed seed gives reproducible schedules and convergence never deteriorates', async () => {
  const first = await optimize(fixture());
  const second = await optimize(fixture());
  assert.deepEqual(first.optimized, second.optimized);
  assert.deepEqual(first.convergence, second.convergence);
  for (let index = 1; index < first.convergence.length; index++) assert.ok(first.convergence[index].score <= first.convergence[index - 1].score);
});

test('a cancelled run stops instead of producing a completed report', async () => {
  await assert.rejects(optimize(fixture(), { isCancelled: async () => true }), /TASK_CANCELLED/);
  const controller = new AbortController();
  let updates = 0;
  await assert.rejects(optimize({ ...fixture(), iterations: 100000 }, {
    signal: controller.signal,
    onProgress: async () => { if (++updates === 3) controller.abort(); },
  }), /TASK_CANCELLED/);
});

test('annealing improves a deliberately poor greedy list schedule', async () => {
  const input = {
    name: 'Вузьке місце', resources: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    tasks: [
      { id: 'short', duration: 2, deadline: 100, dependencies: [] },
      { id: 'long', duration: 10, deadline: 100, dependencies: [], eligibleResources: ['a'] },
      { id: 'followup', duration: 3, deadline: 100, dependencies: ['long'] },
    ], iterations: 10000, seed: 42,
  };
  const result = await optimize(input);
  assert.ok(result.optimized.score < result.baseline.score);
  assert.ok(result.improvementPercent > 0);
});

test('fractional hours preserve timeline lengths and finite scores after normalization', async () => {
  const tiny = fixture();
  tiny.tasks[0].duration = 0.0001;
  assert.throws(() => validateInput(tiny), /0,001/);
  tiny.tasks[0].duration = 1;
  tiny.tasks[0].deadline = 0.0001;
  assert.throws(() => validateInput(tiny), /0,001/);
  const input = fixture();
  input.tasks.forEach((task, index) => {
    task.duration = [0.001, 0.12345, 0.3, 0.7][index];
    task.deadline = [0.1, 0.2, 0.5, 0.8][index];
  });
  const normalized = validateInput(input);
  assert.equal(normalized.tasks[1].duration, 0.123);
  const result = await optimize(input);
  assert.ok(Number.isFinite(result.improvementPercent));
  assert.ok(result.resourceUtilization.every(resource => Number.isFinite(resource.utilization)));
  assert.ok(result.optimized.score <= result.baseline.score);
  for (const schedule of [result.baseline, result.optimized]) {
    for (const task of normalized.tasks) {
      const row = schedule.schedule.find(entry => entry.taskId === task.id);
      assert.ok(Math.abs(row.end - row.start - task.duration) < 1e-9);
      for (const dependency of task.dependencies) assert.ok(row.start >= schedule.schedule.find(entry => entry.taskId === dependency).end);
    }
    const tardiness = schedule.schedule.reduce((total, task) => total + Math.max(0, task.end - task.deadline), 0);
    assert.ok(Math.abs(schedule.tardiness - tardiness) < 1e-9);
    assert.ok(Math.abs(schedule.score - schedule.makespan - 2 * schedule.tardiness) < 1e-9);
  }
});
