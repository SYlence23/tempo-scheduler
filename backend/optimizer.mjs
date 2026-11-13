import { setImmediate as yieldLoop } from 'node:timers/promises';

const idPattern = /^[\p{L}\p{N}_-]{1,40}$/u;
const boundedText = (value, fallback) => String(value ?? fallback).trim().slice(0, 100);
const round = value => Math.round(value * 1000) / 1000;

export function validateInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Вкажіть параметри розкладу.');
  if (!Array.isArray(raw.resources) || raw.resources.length < 1 || raw.resources.length > 8) throw new Error('Потрібно від 1 до 8 виконавців.');
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 2 || raw.tasks.length > 80) throw new Error('Потрібно від 2 до 80 задач.');
  const resourceIds = new Set();
  const resources = raw.resources.map((resource, index) => {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) throw new Error(`Некоректні дані виконавця ${index + 1}.`);
    const id = String(resource?.id ?? `r${index + 1}`);
    if (!idPattern.test(id) || resourceIds.has(id)) throw new Error('Ідентифікатори виконавців мають бути унікальними.');
    resourceIds.add(id);
    return { id, name: boundedText(resource.name, `Виконавець ${index + 1}`) || `Виконавець ${index + 1}` };
  });
  const taskIds = new Set();
  const tasks = raw.tasks.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`Некоректні дані задачі ${index + 1}.`);
    const id = String(task?.id ?? `t${index + 1}`);
    if (!idPattern.test(id) || taskIds.has(id)) throw new Error('Ідентифікатори задач мають бути унікальними.');
    taskIds.add(id);
    const rawDuration = Number(task.duration);
    const rawDeadline = Number(task.deadline ?? 1000);
    if (!Number.isFinite(rawDuration) || rawDuration < 0.001 || rawDuration > 1000) throw new Error(`Тривалість задачі ${index + 1}: від 0,001 до 1000 годин.`);
    if (!Number.isFinite(rawDeadline) || rawDeadline < 0.001 || rawDeadline > 100000) throw new Error(`Дедлайн задачі ${index + 1}: від 0,001 до 100 000 годин.`);
    const duration = round(rawDuration);
    const deadline = round(rawDeadline);
    if (task.dependencies !== undefined && !Array.isArray(task.dependencies)) throw new Error('Залежності мають бути списком ідентифікаторів задач.');
    const dependencies = [...new Set((task.dependencies ?? []).map(String))];
    if (task.eligibleResources !== undefined && !Array.isArray(task.eligibleResources)) throw new Error('Допустимі виконавці мають бути списком.');
    const eligibleResources = task.eligibleResources?.length ? [...new Set(task.eligibleResources.map(String))] : [...resourceIds];
    if (eligibleResources.some(resourceId => !resourceIds.has(resourceId))) throw new Error(`Задача ${id} містить невідомого виконавця.`);
    return { id, name: boundedText(task.name, `Задача ${index + 1}`) || `Задача ${index + 1}`, duration, deadline, dependencies, eligibleResources };
  });
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Залежності утворюють цикл. Розклад неможливий.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of taskMap.get(id).dependencies) {
      if (!taskMap.has(dependency)) throw new Error(`Задача ${id} залежить від невідомої задачі ${dependency}.`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  tasks.forEach(task => visit(task.id));
  const iterations = Number(raw.iterations ?? 100000);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2000000) throw new Error('Кількість ітерацій: від 1 000 до 2 000 000.');
  const seed = Number(raw.seed ?? 42);
  if (!Number.isSafeInteger(seed)) throw new Error('Seed має бути цілим числом.');
  return { name: boundedText(raw.name, 'Новий розклад') || 'Новий розклад', resources, tasks, iterations, seed };
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export async function optimize(raw, { onProgress = async () => {}, isCancelled = async () => false, signal } = {}) {
  const input = validateInput(raw);
  const started = performance.now();
  const random = randomGenerator(input.seed);
  const count = input.tasks.length;
  const resourceCount = input.resources.length;
  const resourceIndex = new Map(input.resources.map((resource, index) => [resource.id, index]));
  const taskIndex = new Map(input.tasks.map((task, index) => [task.id, index]));
  const durations = Float64Array.from(input.tasks.map(task => task.duration));
  const deadlines = Float64Array.from(input.tasks.map(task => task.deadline));
  const dependencies = input.tasks.map(task => task.dependencies.map(id => taskIndex.get(id)));
  const allowed = input.tasks.map(task => task.eligibleResources.map(id => resourceIndex.get(id)));
  const ranks = new Int16Array(count);
  const done = new Uint8Array(count);
  const finishes = new Float64Array(count);
  const resourceEnds = new Float64Array(resourceCount);
  const starts = new Float64Array(count);
  const assigned = new Int16Array(count);
  const order = Array.from({ length: count }, (_, index) => index);
  const assignment = allowed.map(options => options[0]);

  function evaluate(priority, allocation, capture = false, greedy = false) {
    priority.forEach((task, rank) => { ranks[task] = rank; });
    done.fill(0);
    finishes.fill(0);
    resourceEnds.fill(0);
    let tardiness = 0;
    let makespan = 0;
    for (let scheduled = 0; scheduled < count; scheduled++) {
      let selected = -1;
      let bestRank = count + 1;
      let dependencyEnd = 0;
      for (let index = 0; index < count; index++) {
        if (done[index] || ranks[index] >= bestRank) continue;
        let ready = true;
        let end = 0;
        for (const dependency of dependencies[index]) {
          if (!done[dependency]) { ready = false; break; }
          end = Math.max(end, finishes[dependency]);
        }
        if (ready) { selected = index; bestRank = ranks[index]; dependencyEnd = end; }
      }
      let resource = allocation[selected];
      if (greedy) {
        resource = allowed[selected].reduce((best, candidate) => resourceEnds[candidate] < resourceEnds[best] ? candidate : best, allowed[selected][0]);
        allocation[selected] = resource;
      }
      const start = Math.max(dependencyEnd, resourceEnds[resource]);
      const end = start + durations[selected];
      done[selected] = 1;
      finishes[selected] = end;
      resourceEnds[resource] = end;
      tardiness += Math.max(0, end - deadlines[selected]);
      makespan = Math.max(makespan, end);
      if (capture) { starts[selected] = start; assigned[selected] = resource; }
    }
    const result = { makespan, tardiness, score: makespan + 2 * tardiness };
    if (capture) {
      result.schedule = input.tasks.map((task, index) => ({
        taskId: task.id, name: task.name, resourceId: input.resources[assigned[index]].id,
        start: round(starts[index]), end: round(finishes[index]), duration: task.duration,
        deadline: task.deadline, late: round(Math.max(0, finishes[index] - task.deadline)),
      })).sort((left, right) => left.start - right.start || left.taskId.localeCompare(right.taskId));
      result.makespan = round(makespan);
      result.tardiness = round(tardiness);
      result.score = round(result.score);
    }
    return result;
  }

  const checkCancelled = async () => {
    if (signal?.aborted || await isCancelled()) throw new Error('TASK_CANCELLED');
  };
  await checkCancelled();
  await onProgress(3, 'Побудова початкового розкладу');
  const baseline = evaluate(order, assignment, true, true);
  let currentScore = baseline.score;
  let bestScore = baseline.score;
  let bestOrder = [...order];
  let bestAssignment = [...assignment];
  const convergence = [{ iteration: 0, score: baseline.score }];
  const reportEvery = Math.max(500, Math.floor(input.iterations / 100));
  let lastYield = performance.now();
  let lastReported = 0;

  for (let iteration = 1; iteration <= input.iterations; iteration++) {
    const first = Math.floor(random() * count);
    let second = Math.floor(random() * count);
    if (second === first) second = (second + 1) % count;
    const changeAssignment = random() < 0.35 && allowed[first].length > 1;
    let oldResource;
    if (changeAssignment) {
      oldResource = assignment[first];
      assignment[first] = allowed[first][Math.floor(random() * allowed[first].length)];
    } else {
      [order[first], order[second]] = [order[second], order[first]];
    }
    const candidateScore = evaluate(order, assignment).score;
    const phase = (iteration % Math.max(1000, Math.floor(input.iterations / 5))) / Math.max(1000, Math.floor(input.iterations / 5));
    const temperature = Math.max(0.001, baseline.score * 0.06 * (1 - phase) ** 3);
    const delta = candidateScore - currentScore;
    if (delta <= 0 || random() < Math.exp(-delta / temperature)) {
      currentScore = candidateScore;
      if (candidateScore < bestScore - 1e-8) {
        bestScore = candidateScore;
        bestOrder = [...order];
        bestAssignment = [...assignment];
      }
    } else if (changeAssignment) {
      assignment[first] = oldResource;
    } else {
      [order[first], order[second]] = [order[second], order[first]];
    }
    if (iteration % 500 === 0 && performance.now() - lastYield > 30) {
      await yieldLoop();
      await checkCancelled();
      lastYield = performance.now();
    }
    if (iteration - lastReported >= reportEvery || iteration === input.iterations) {
      lastReported = iteration;
      convergence.push({ iteration, score: round(bestScore) });
      await onProgress(Math.min(97, 5 + Math.floor(iteration / input.iterations * 92)), `Пошук кращого розкладу · ${iteration.toLocaleString('uk-UA')} / ${input.iterations.toLocaleString('uk-UA')} ітерацій`);
    }
  }

  await checkCancelled();
  const optimized = evaluate(bestOrder, bestAssignment, true);
  const resourceUtilization = input.resources.map(resource => {
    const busy = optimized.schedule.filter(task => task.resourceId === resource.id).reduce((total, task) => total + task.duration, 0);
    return { resourceId: resource.id, name: resource.name, busy: round(busy), utilization: round(busy / optimized.makespan * 100) };
  });
  await onProgress(99, 'Формування діаграми та звіту');
  return {
    baseline, optimized,
    improvementPercent: round(Math.max(0, (baseline.score - optimized.score) / baseline.score * 100)),
    iterations: input.iterations, elapsedMs: Math.round(performance.now() - started), resourceUtilization,
    convergence, algorithm: 'Simulated annealing + list scheduling',
  };
}
