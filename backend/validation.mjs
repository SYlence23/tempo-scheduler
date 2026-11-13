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
  const timing = {};
  if (raw.startTime !== undefined || raw.timeDisplay !== undefined) {
    timing.startTime = raw.startTime === undefined ? '09:00' : raw.startTime;
    timing.timeDisplay = raw.timeDisplay === undefined ? 'clock' : raw.timeDisplay;
    if (typeof timing.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.startTime)) throw new Error('Початок плану має бути у форматі ГГ:ХХ.');
    if (!['clock', 'hours'].includes(timing.timeDisplay)) throw new Error('Невідомий формат часу.');
  }
  return { name: boundedText(raw.name, 'Новий розклад') || 'Новий розклад', resources, tasks, iterations, seed, ...timing };
}
