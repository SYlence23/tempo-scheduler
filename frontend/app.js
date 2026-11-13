const icons = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value, digits = 1) => Number(value || 0).toLocaleString('uk-UA', { maximumFractionDigits: digits });
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const statuses = { queued: 'У черзі', running: 'Виконується', completed: 'Завершено', failed: 'Помилка', cancelled: 'Скасовано' };
const copy = value => JSON.parse(JSON.stringify(value));
const task = (id, name, duration, deadline, dependencies = [], eligibleResources) => ({ id: `T${id}`, name, duration, deadline, dependencies: dependencies.map(value => `T${value}`), ...(eligibleResources ? { eligibleResources } : {}) });
const presets = {
  sprint: {
    label: 'Продуктовий спринт', description: 'Від ідеї до готового релізу', icon: 'layers',
    input: { name: 'Реліз вебпродукту', resources: [{ id: 'R1', name: 'Команда A' }, { id: 'R2', name: 'Команда B' }, { id: 'R3', name: 'Команда C' }], tasks: [task(1, 'Аналіз вимог', 6, 8), task(2, 'Архітектура системи', 8, 20, [1]), task(3, 'Прототип інтерфейсу', 5, 15, [1]), task(4, 'Схема бази даних', 10, 30, [2]), task(5, 'Розробка API', 12, 44, [4]), task(6, 'Розробка інтерфейсу', 14, 34, [3]), task(7, 'Мобільна адаптація', 8, 44, [6]), task(8, 'Інтеграція модулів', 6, 50, [5, 6]), task(9, 'Тестування API', 6, 49, [5]), task(10, 'Тестування UI', 4, 50, [7]), task(11, 'Регресійні тести', 7, 57, [8, 9, 10]), task(12, 'Публікація релізу', 3, 60, [11])], iterations: 200000, seed: 42 }
  },
  studio: {
    label: 'Дизайн-студія', description: 'Кілька клієнтів. Одна команда.', icon: 'spark',
    input: { name: 'Тиждень у дизайн-студії', resources: [{ id: 'R1', name: 'Дизайнер 1' }, { id: 'R2', name: 'Дизайнер 2' }, { id: 'R3', name: 'Дизайнер 3' }], tasks: [task(1, 'Брендбук · North', 14, 24), task(2, 'Презентація · Vela', 5, 9), task(3, 'Лендинг · Bloom', 12, 24), task(4, 'Бриф · Atelier', 3, 6), task(5, 'Логотип · Atelier', 9, 19, [4]), task(6, 'Соцмережі · North', 5, 31, [1]), task(7, 'Іконки · Bloom', 4, 29, [3]), task(8, 'Паковання · Atelier', 8, 29, [5]), task(9, 'Банери · Vela', 5, 17, [2]), task(10, 'Правки · Bloom', 3, 34, [7]), task(11, 'Підготовка до друку', 6, 37, [6, 8]), task(12, 'Передача матеріалів', 2, 39, [9, 10, 11])], iterations: 200000, seed: 42 }
  },
  production: {
    label: 'Виробнича зміна', description: 'Обладнання працює злагоджено', icon: 'branch',
    input: { name: 'План виробничої зміни', resources: [{ id: 'R1', name: 'Лінія A' }, { id: 'R2', name: 'Лінія B' }, { id: 'R3', name: 'Лінія C' }, { id: 'R4', name: 'Лінія D' }], tasks: [task(1, 'Підготовка сировини A', 4, 6), task(2, 'Підготовка сировини B', 3, 5), task(3, 'Заготовки партії A', 11, 19, [1]), task(4, 'Заготовки партії B', 7, 15, [2]), task(5, 'Деталі партії C', 13, 20), task(6, 'Обробка партії A', 8, 27, [3]), task(7, 'Обробка партії B', 6, 22, [4]), task(8, 'Обробка партії C', 9, 30, [5]), task(9, 'Покриття партії A', 5, 34, [6]), task(10, 'Покриття партії B', 4, 28, [7]), task(11, 'Контроль партії C', 3, 34, [8]), task(12, 'Контроль якості', 4, 39, [9, 10]), task(13, 'Паковання A / B', 5, 44, [12]), task(14, 'Паковання C', 4, 40, [11]), task(15, 'Відвантаження', 2, 46, [13, 14])], iterations: 200000, seed: 42 }
  }
};

const state = { page: 'workspace', preset: 'sprint', form: copy(presets.sprint.input), token: localStorage.getItem('tempo-token') || '', user: null, jobs: [], selectedJob: null, health: null, healthError: false, historyFilter: 'all', scheduleMode: 'optimized', authMode: 'login', authBusy: false, running: false, metrics: null, metricsError: '', stream: null, liveJobId: null, pendingRun: false, mobileOpen: false };
const app = document.querySelector('#app');
const dialog = document.querySelector('#auth-dialog');
let refreshBusy = false;
let metricsBusy = false;

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) signOut(false);
    throw new Error(data.error || `Запит не виконано (${response.status})`);
  }
  return data;
}

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  document.querySelector('#toasts').append(item);
  setTimeout(() => item.remove(), 5500);
}

function initials(name) {
  return String(name || 'Гість').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

function shell() {
  app.innerHTML = `<div class="app-shell"><aside class="sidebar ${state.mobileOpen ? 'mobile-open' : ''}">
    <a href="#workspace" class="brand" aria-label="Tempo, робочий простір"><span class="brand-mark"><b></b><b></b><b></b></span>tempo</a>
    <div class="brand-caption">Make room for better.</div><div class="nav-label">ВАША ЛАБОРАТОРІЯ</div>
    <nav class="nav" aria-label="Головна навігація">
      <button class="nav-item ${state.page === 'workspace' ? 'active' : ''}" data-nav="workspace">${icons('grid')}<span>Робочий простір</span></button>
      <button class="nav-item ${state.page === 'history' ? 'active' : ''}" data-nav="history">${icons('clock')}<span>Історія розрахунків</span><span class="nav-count" id="nav-job-count" ${state.jobs.length ? '' : 'hidden'}>${state.jobs.length}</span></button>
      <button class="nav-item ${state.page === 'system' ? 'active' : ''}" data-nav="system">${icons('activity')}<span>Стан системи</span></button>
      <a class="nav-item" href="/architecture.html" target="_blank" rel="noopener">${icons('branch')}<span>Архітектура</span></a>
    </nav>
    <div class="sidebar-note"><div class="side-orbit" aria-hidden="true"><span></span><span></span><span></span></div><p>Хороший план залишає<br>місце для найважливішого.</p><div class="side-status"><i class="status-dot ${state.health && !state.healthError ? 'online' : ''}" id="side-db-dot"></i><span id="side-db-label">${state.health && !state.healthError ? 'PostgreSQL підключено' : 'Перевіряємо з’єднання'}</span></div></div>
    </aside><button class="mobile-shade" data-action="close-menu" aria-label="Закрити меню"></button><div class="main-shell"><header class="topbar"><button class="mobile-menu" data-action="menu" aria-label="Відкрити меню">${icons('menu')}</button><div class="breadcrumb"><span>Лабораторія</span><span>/</span><strong id="page-breadcrumb">${pageName()}</strong></div><div class="top-actions"><button class="connection-button" data-action="health" title="Перевірити підключення та сервер балансувальника"><i class="status-dot ${state.health && !state.healthError ? 'online' : state.healthError ? 'offline' : ''}" id="health-dot"></i><span class="connection-server" id="health-label">${state.health ? escapeHtml(state.health.server) : 'З’єднання'}</span></button><div id="profile-area">${profileMarkup()}</div></div></header><main class="content" id="main-content"></main></div></div>`;
  renderPage();
}

function pageName() { return { workspace: 'Робочий простір', history: 'Історія розрахунків', system: 'Стан системи' }[state.page]; }

function profileMarkup() {
  return `<button class="profile-button" data-action="${state.user ? 'profile' : 'auth'}" title="${state.user ? 'Натисніть, щоб вийти з облікового запису' : 'Увійти в обліковий запис'}"><span class="avatar">${state.user ? escapeHtml(initials(state.user.name)) : icons('user')}</span><span class="profile-name">${state.user ? escapeHtml(state.user.name || state.user.email) : 'Увійти'}</span></button>`;
}

function renderPage() {
  document.querySelector('#page-breadcrumb').textContent = pageName();
  document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.page));
  const main = document.querySelector('#main-content');
  if (state.page === 'workspace') renderWorkspace(main);
  if (state.page === 'history') renderHistory(main);
  if (state.page === 'system') renderSystem(main);
}

function footer() { return `<footer class="footer"><span>Tempo · Лабораторія оптимізації розкладу</span><a href="/architecture.html" target="_blank" rel="noopener">Як влаштована система ${icons('arrow')}</a></footer>`; }

function renderWorkspace(main) {
  main.innerHTML = `<section class="hero"><div><div class="eyebrow"><span class="line"></span>ПЛАНУЙТЕ З РОЗУМОМ</div><h1>Менше простоїв.<br><em>Більше встигаєте.</em></h1><p>Розподіліть задачі між виконавцями, врахуйте залежності<br class="desktop-break"> й знайдіть розклад, у якому все на своєму місці.</p></div><div class="hero-side" aria-hidden="true"><div class="hero-line"><i></i><i></i><i></i><i></i><i></i></div><span>Кожна година має значення.</span></div></section>
    <section aria-labelledby="scenario-heading"><div class="section-title"><h2 id="scenario-heading">Почніть із готового сценарію</h2><span class="section-kicker">01 / ВХІДНІ ДАНІ</span></div><div class="scenario-grid">${Object.entries(presets).map(([key, preset]) => `<button class="scenario ${state.preset === key ? 'active' : ''}" data-preset="${key}"><span class="scenario-icon">${icons(preset.icon)}</span><span><h3>${preset.label}</h3><p>${preset.description}</p></span><span class="scenario-check">${state.preset === key ? icons('check') : ''}</span></button>`).join('')}</div></section>
    <div class="workspace-grid"><section class="panel" aria-labelledby="tasks-heading"><div class="panel-head"><div><h2 id="tasks-heading">Ваш план роботи</h2><p>Задачі, терміни й доступні виконавці</p></div><div class="import-export"><button class="subtle-button" data-action="import" title="Імпортувати план JSON">${icons('upload')}Імпорт</button><button class="subtle-button" data-action="export" title="Зберегти план JSON">${icons('download')}Експорт</button></div></div><div class="panel-body"><label class="project-name-label" for="project-name">НАЗВА РОЗРАХУНКУ</label><input class="project-name" id="project-name" maxlength="120" value="${escapeHtml(state.form.name)}" placeholder="Назва вашого проєкту"><div class="resources-top"><label>ВИКОНАВЦІ / РЕСУРСИ</label><div class="stepper"><button data-action="resource-minus" aria-label="Прибрати виконавця" ${state.form.resources.length <= 2 ? 'disabled' : ''}>−</button><span>${state.form.resources.length}</span><button data-action="resource-plus" aria-label="Додати виконавця" ${state.form.resources.length >= 8 ? 'disabled' : ''}>+</button></div></div><div class="resource-pills">${state.form.resources.map(resource => `<label class="resource-pill"><b>${escapeHtml(resource.id)}</b><input data-resource="${escapeHtml(resource.id)}" value="${escapeHtml(resource.name)}" maxlength="60" aria-label="Ім’я виконавця ${escapeHtml(resource.id)}"></label>`).join('')}</div></div><div class="table-wrap"><table class="task-table"><thead><tr><th>ID</th><th>Задача</th><th title="Тривалість у годинах">Години</th><th title="Бажаний час завершення від початку плану">Дедлайн</th><th title="ID задач, які повинні завершитися раніше, через кому">Залежності</th><th title="ID дозволених ресурсів через кому; порожньо — усі">Ресурси</th><th><span class="visually-hidden">Видалити</span></th></tr></thead><tbody>${state.form.tasks.map(row => taskRow(row)).join('')}</tbody></table></div><div class="table-foot"><button class="text-button" data-action="add-task">${icons('plus')}Додати задачу</button><span id="task-counter">${state.form.tasks.length} / 80 задач</span></div><div class="help-note">${icons('info')}<span>Час — у годинах від початку плану. Залежності: T1, T2. Ресурси: R1, R2; порожньо — доступні всі.</span></div></section><aside class="right-rail"><section class="panel settings-panel"><div class="panel-head"><div><h2>Знайдемо кращий розклад</h2><p>02 / ОПТИМІЗАЦІЯ</p></div></div><div class="panel-body"><div class="settings-fields"><label class="setting-label" for="iterations">ГЛИБИНА ПОШУКУ</label><select class="setting-select" id="iterations"><option value="20000" ${state.form.iterations === 20000 ? 'selected' : ''}>Швидко · 20 000 ітерацій</option><option value="200000" ${state.form.iterations === 200000 ? 'selected' : ''}>Ретельно · 200 000 ітерацій</option><option value="2000000" ${state.form.iterations === 2000000 ? 'selected' : ''}>Стрес-тест · 2 000 000 ітерацій</option>${![20000, 200000, 2000000].includes(state.form.iterations) ? `<option selected value="${state.form.iterations}">Власний · ${number(state.form.iterations, 0)}</option>` : ''}</select><p class="settings-description">Більше ітерацій — більше перевірених варіантів розподілу. Результат порівнюється з початковим планом.</p></div><div class="settings-stat"><span>Задач у плані</span><strong id="stat-tasks">${state.form.tasks.length}</strong></div><div class="settings-stat"><span>Доступних виконавців</span><strong id="stat-resources">${state.form.resources.length}</strong></div><div class="settings-stat"><span>Загальний обсяг</span><strong id="stat-work">${number(totalWork())} год</strong></div><button class="run-button" data-action="run" ${state.running ? 'disabled' : ''}>${icons('spark')}<span>${state.running ? 'Створюємо розрахунок…' : 'Оптимізувати розклад'}</span>${icons('arrow')}</button><p class="settings-footnote">Розрахунок виконується у фоні.<br>Ви можете продовжувати роботу.</p></div></section><div class="insight">${icons('layers')}<h3>Залежності під контролем</h3><p>Наступна задача почнеться лише після завершення всіх попередніх. Один виконавець — одна задача за раз.</p></div></aside></div><section class="results-section" id="job-area" aria-live="polite"></section>${footer()}`;
  renderJobArea();
}

function taskRow(row) {
  return `<tr data-task="${escapeHtml(row.id)}"><td>${escapeHtml(row.id)}</td><td><input class="task-name" data-field="name" value="${escapeHtml(row.name)}" maxlength="100" aria-label="Назва задачі ${escapeHtml(row.id)}"></td><td><input type="number" data-field="duration" min="0.1" max="1000" step="0.5" value="${Number(row.duration)}" aria-label="Тривалість задачі ${escapeHtml(row.id)}"></td><td><input type="number" data-field="deadline" min="0" max="100000" step="1" value="${Number(row.deadline)}" aria-label="Дедлайн задачі ${escapeHtml(row.id)}"></td><td><input class="task-deps" data-field="dependencies" value="${escapeHtml(row.dependencies.join(', '))}" placeholder="—" aria-label="Залежності задачі ${escapeHtml(row.id)}"></td><td><input class="task-eligible" data-field="eligibleResources" value="${escapeHtml((row.eligibleResources || []).join(', '))}" placeholder="Усі" aria-label="Доступні ресурси задачі ${escapeHtml(row.id)}"></td><td><button class="task-delete" data-remove-task="${escapeHtml(row.id)}" aria-label="Видалити задачу ${escapeHtml(row.id)}">${icons('trash')}</button></td></tr>`;
}

function totalWork() { return state.form.tasks.reduce((sum, row) => sum + (Number(row.duration) || 0), 0); }

function syncForm() {
  if (state.page !== 'workspace') return;
  const name = document.querySelector('#project-name');
  if (name) state.form.name = name.value.trim();
  const iterations = document.querySelector('#iterations');
  if (iterations) state.form.iterations = Number(iterations.value);
  document.querySelectorAll('[data-resource]').forEach(input => {
    const resource = state.form.resources.find(row => row.id === input.dataset.resource);
    if (resource) resource.name = input.value.trim() || resource.id;
  });
  document.querySelectorAll('tr[data-task]').forEach(tr => {
    const row = state.form.tasks.find(task => task.id === tr.dataset.task);
    if (!row) return;
    tr.querySelectorAll('[data-field]').forEach(input => {
      const key = input.dataset.field;
      if (key === 'duration' || key === 'deadline') row[key] = Number(input.value);
      else if (key === 'dependencies' || key === 'eligibleResources') row[key] = input.value.split(/[,;\s]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
      else row[key] = input.value.trim();
    });
  });
}

function updateSummary() {
  document.querySelector('#stat-work')?.replaceChildren(document.createTextNode(`${number(totalWork())} год`));
}

function renderJobArea() {
  const area = document.querySelector('#job-area');
  if (!area) return;
  const job = state.selectedJob;
  if (!job) {
    area.innerHTML = `<div class="empty-result"><span class="empty-icon">${icons('activity')}</span><div><h3>Тут з’явиться ваш оптимізований розклад</h3><p>Налаштуйте задачі та запустіть розрахунок. Tempo порівняє варіанти<br class="desktop-break"> й покаже результат на діаграмі Ганта.</p></div></div>`;
    return;
  }
  if (!terminal(job.status)) {
    const queued = job.status === 'queued';
    const progress = Math.min(100, Math.max(0, Number(job.progress) || 0));
    area.innerHTML = `<div class="live-panel"><div class="live-top"><div class="live-title"><span class="spinner"></span><div><h3>${queued ? 'Ваш розрахунок у черзі' : 'Шукаємо кращий розклад'}</h3><p>${escapeHtml(job.name)}</p></div></div><strong class="live-value">${Math.round(progress)}<small>%</small></strong></div><div class="progress-track" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Прогрес оптимізації"><span style="width:${progress}%"></span></div><div class="live-bottom"><div class="live-meta"><span>${escapeHtml(job.stage || (queued ? 'Очікуємо вільного воркера' : 'Перевіряємо варіанти розподілу'))}</span>${queued && job.queue_position != null ? `<span>Позиція: ${number(job.queue_position, 0)}</span>` : ''}${job.estimated_wait_seconds != null && queued ? `<span>Очікування ≈ ${formatWait(job.estimated_wait_seconds)}</span>` : ''}${job.worker_id ? `<span>${escapeHtml(job.worker_id)}</span>` : ''}</div><button class="text-button danger-text" data-cancel="${escapeHtml(job.id)}">${icons('close')}Скасувати</button></div></div>`;
    return;
  }
  if (job.status !== 'completed' || !job.result) {
    area.innerHTML = `<div class="terminal-note"><strong>${job.status === 'cancelled' ? 'Розрахунок скасовано' : 'Розрахунок не завершився'}</strong><br>${escapeHtml(job.error || (job.status === 'cancelled' ? 'Можна змінити параметри та запустити нову оптимізацію.' : 'Спробуйте змінити вхідні дані або глибину пошуку.'))}</div>`;
    return;
  }
  const result = typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
  const mode = state.scheduleMode;
  const plan = result[mode] || result.optimized;
  const baseline = result.baseline || {};
  const optimized = result.optimized || {};
  const input = job.input || state.form;
  const elapsed = job.execution_ms ?? result.elapsedMs;
  area.innerHTML = `<div class="result-heading"><div><div class="eyebrow"><span class="line"></span>03 / РЕЗУЛЬТАТ</div><h2>Ваш час. У кращому порядку.</h2><p>${escapeHtml(job.name)} · ${escapeHtml(job.worker_id || 'Воркер')} · ${number(Number(elapsed || 0) / 1000, 2)} с</p></div><div class="heading-actions"><a class="subtle-button" href="${downloadUrl(job.id)}">${icons('download')}JSON-звіт</a></div></div><div class="metric-grid"><div class="metric-card accent"><span class="metric-label">ПОКРАЩЕННЯ ПЛАНУ</span><div class="metric-number">${number(result.improvementPercent, 1)}<small>%</small></div><span class="metric-detail">За зваженою оцінкою розкладу</span></div><div class="metric-card"><span class="metric-label">ТРИВАЛІСТЬ ПЛАНУ</span><div class="metric-number">${number(optimized.makespan)}<small>год</small></div><span class="metric-detail">Було ${number(baseline.makespan)} год</span></div><div class="metric-card"><span class="metric-label">СУМАРНЕ ЗАПІЗНЕННЯ</span><div class="metric-number">${number(optimized.tardiness)}<small>год</small></div><span class="metric-detail">Було ${number(baseline.tardiness)} год</span></div><div class="metric-card"><span class="metric-label">ПЕРЕВІРЕНО ВАРІАНТІВ</span><div class="metric-number">${compactNumber(result.iterations)}</div><span class="metric-detail">Імітація відпалу · ${input.tasks?.length || 0} задач</span></div></div><section class="panel"><div class="panel-head"><div><h2>Розклад на діаграмі Ганта</h2><p>Час у годинах від початку виконання</p></div><div class="segmented" aria-label="Варіант розкладу"><button data-schedule="optimized" class="${mode === 'optimized' ? 'active' : ''}">Оптимізований</button><button data-schedule="baseline" class="${mode === 'baseline' ? 'active' : ''}">Початковий</button></div></div><div class="gantt-wrap">${ganttMarkup(plan, input.resources || [])}</div><div class="gantt-legend"><span><i class="legend-dot"></i>У межах дедлайну</span><span><i class="legend-dot late"></i>Завершення після дедлайну</span></div></section><div class="analytics-grid"><section class="panel"><div class="panel-head"><div><h2>Як покращувався план</h2><p>Оцінка = тривалість + 2 × сумарне запізнення</p></div>${icons('activity')}</div><div class="chart-container">${convergenceMarkup(result.convergence || [])}</div><div class="chart-caption"><span>Початок пошуку</span><span>${number(result.iterations, 0)} ітерацій</span></div></section><section class="panel"><div class="panel-head"><div><h2>Завантаженість виконавців</h2><p>Робочий час / тривалість плану</p></div>${icons('layers')}</div><div class="util-list">${(result.resourceUtilization || []).map(resource => { const percentage = Math.min(100, Math.max(0, Number(resource.utilization))); return `<div class="util-item"><div class="util-label"><span>${escapeHtml(resource.name || resource.resourceId)}</span><strong>${number(percentage, 0)}% · ${number(resource.busy)} год</strong></div><div class="util-track"><span style="width:${percentage}%"></span></div></div>`; }).join('')}</div></section></div>`;
}

function ganttMarkup(plan, resources) {
  const max = Math.max(1, Number(plan.makespan) || 1);
  const schedule = plan.schedule || [];
  return `<div class="gantt"><div class="gantt-axis"><div class="axis-ticks">${Array.from({ length: 6 }, (_, index) => `<span style="left:${index * 20}%">${number(max * index / 5)}</span>`).join('')}</div></div>${resources.map(resource => `<div class="gantt-row"><div class="gantt-resource"><span class="resource-dot"></span>${escapeHtml(resource.name)}</div><div class="gantt-track">${schedule.filter(row => row.resourceId === resource.id).map(row => { const left = Math.min(100, Math.max(0, Number(row.start) / max * 100)); const width = Math.min(100 - left, Math.max(0, Number(row.duration ?? row.end - row.start) / max * 100)); const label = `${row.taskId} · ${row.name}: ${number(row.start)}–${number(row.end)} год. Дедлайн ${number(row.deadline)} год${row.late ? '. Із запізненням' : ''}`; return `<button type="button" class="gantt-bar ${row.late ? 'late' : ''}" style="left:${left}%;width:${width}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(row.taskId)} ${escapeHtml(row.name)}</button>`; }).join('')}</div></div>`).join('')}</div>`;
}

function convergenceMarkup(points) {
  if (!points.length) return `<div class="loading-text">Дані збіжності відсутні</div>`;
  const values = points.filter(point => Number.isFinite(Number(point.score)) && Number.isFinite(Number(point.iteration)));
  if (!values.length) return '';
  const scores = values.map(point => Number(point.score));
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || Math.max(1, max * .1);
  const lastIteration = Math.max(1, ...values.map(point => Number(point.iteration)));
  const coords = values.map(point => [35 + Number(point.iteration) / lastIteration * 390, 115 - (Number(point.score) - min) / range * 90]);
  const path = coords.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return `<svg viewBox="0 0 450 145" role="img" aria-label="Зміна найкращої оцінки розкладу від ${number(scores[0])} до ${number(scores.at(-1))}"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a9c488" stop-opacity=".22"/><stop offset="100%" stop-color="#a9c488" stop-opacity="0"/></linearGradient></defs>${[25, 70, 115].map(y => `<path d="M35 ${y}H425" stroke="#edf0e6" stroke-dasharray="3 4" fill="none"/>`).join('')}<text x="0" y="28" fill="#a4ad97" font-size="9">${number(max, 0)}</text><text x="0" y="118" fill="#a4ad97" font-size="9">${number(min, 0)}</text><path d="${path} L${coords.at(-1)[0]} 135 L35 135 Z" fill="url(#chart-fill)"/><path d="${path}" stroke="#82a261" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="${coords.at(-1)[0]}" cy="${coords.at(-1)[1]}" r="3" fill="#66864c" stroke="white" stroke-width="2"/></svg>`;
}

function compactNumber(value) { return Number(value || 0) >= 1000000 ? `${number(Number(value) / 1000000, 1)} млн` : Number(value || 0) >= 1000 ? `${number(Number(value) / 1000, 0)} тис.` : number(value, 0); }
function formatWait(seconds) { return Number(seconds) < 60 ? `${number(seconds, 0)} с` : `${number(Number(seconds) / 60, 1)} хв`; }
function downloadUrl(id) { return `/api/jobs/${encodeURIComponent(id)}/download?token=${encodeURIComponent(state.token)}`; }
function dateLabel(date) { return date ? new Date(date).toLocaleString('uk-UA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Щойно'; }

function renderHistory(main) {
  main.innerHTML = `<section class="hero"><div><div class="eyebrow"><span class="line"></span>ІСТОРІЯ РОЗРАХУНКІВ</div><h1 class="single">Кожен план —<br><em>крок до кращого.</em></h1><p>Повертайтеся до попередніх результатів, порівнюйте розклади<br class="desktop-break"> та завантажуйте звіти ваших експериментів.</p></div></section>${!state.user ? authGate('Ваші розрахунки зберігаються тут', 'Увійдіть, щоб побачити історію, активні задачі та готові результати.') : `<div class="history-tools" role="group" aria-label="Фільтр історії">${[['all', 'Усі розрахунки'], ['active', 'Активні'], ['completed', 'Завершені'], ['other', 'Інші']].map(([key, label]) => `<button class="filter-button ${state.historyFilter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`).join('')}<button class="text-button" style="margin-left:auto" data-action="refresh-history">Оновити</button></div><div class="history-list" id="history-list">${historyCards()}</div>`}${footer()}`;
}

function historyCards() {
  const jobs = state.jobs.filter(job => state.historyFilter === 'all' || (state.historyFilter === 'active' ? !terminal(job.status) : state.historyFilter === 'other' ? ['failed', 'cancelled'].includes(job.status) : job.status === state.historyFilter));
  if (!jobs.length) return `<div class="center-empty">${icons('clock')}<h2>${state.jobs.length ? 'У цій категорії ще порожньо' : 'Перший план уже близько'}</h2><p>Створіть розрахунок у робочому просторі. Його стан і результат автоматично збережуться в історії.</p><button class="subtle-button" data-nav="workspace">До робочого простору ${icons('arrow')}</button></div>`;
  return jobs.map(job => `<article class="history-card"><div class="history-leading"><div class="history-icon">${icons(job.status === 'completed' ? 'check' : job.status === 'running' ? 'activity' : 'layers')}</div><div><h2 class="history-name">${escapeHtml(job.name)}</h2><div class="history-sub"><span>${dateLabel(job.created_at)}</span>${job.input?.tasks ? `<span>${job.input.tasks.length} задач · ${job.input.resources?.length || 0} виконавців</span>` : ''}${job.worker_id ? `<span>${escapeHtml(job.worker_id)}</span>` : ''}${job.execution_ms != null ? `<span>${number(job.execution_ms / 1000, 2)} с</span>` : ''}</div></div></div><div class="history-trailing"><span class="status-label ${escapeHtml(job.status)}">${statuses[job.status] || escapeHtml(job.status)}${job.status === 'running' ? ` · ${number(job.progress, 0)}%` : ''}</span><button class="subtle-button" data-view-job="${escapeHtml(job.id)}">Переглянути ${icons('arrow')}</button>${job.status === 'completed' ? `<a href="${downloadUrl(job.id)}" class="text-button" title="Завантажити звіт" aria-label="Завантажити звіт ${escapeHtml(job.name)}">${icons('download')}</a>` : !terminal(job.status) ? `<button class="text-button danger-text" data-cancel="${escapeHtml(job.id)}" title="Скасувати" aria-label="Скасувати ${escapeHtml(job.name)}">${icons('close')}</button>` : ''}</div></article>`).join('');
}

function authGate(title, description) { return `<div class="center-empty auth-gate">${icons('user')}<h2>${title}</h2><p>${description}</p><button class="run-button" data-action="auth">Увійти в Tempo ${icons('arrow')}</button></div>`; }

function renderSystem(main) {
  main.innerHTML = `<section class="hero"><div><div class="eyebrow"><span class="line"></span>СИСТЕМА В РЕАЛЬНОМУ ЧАСІ</div><h1 class="single">За кожним планом —<br><em>злагоджена робота.</em></h1><p>Сервери, воркери й черга розрахунків.<br>Усе, що допомагає Tempo працювати без простоїв.</p></div><div class="hero-side"><button class="subtle-button" data-action="refresh-metrics">${icons('activity')}Оновити показники</button></div></section><div id="system-content">${systemContent()}</div>${footer()}`;
}

function systemContent() {
  if (!state.user) return authGate('Моніторинг для адміністратора', 'Увійдіть під обліковим записом адміністратора, щоб бачити чергу й обчислювальні вузли.');
  if (state.user.role.toLowerCase() !== 'admin') return `<div class="center-empty">${icons('server')}<h2>Панель адміністратора</h2><p>Ви увійшли як користувач. Метрики системи доступні адміністратору. Ваші розрахунки та історія доступні у звичайному режимі.</p><button class="subtle-button" data-action="switch-admin">Увійти як адміністратор ${icons('arrow')}</button></div>`;
  if (state.metricsError) return `<div class="terminal-note">${escapeHtml(state.metricsError)}<br><button class="text-button" data-action="refresh-metrics">Спробувати ще раз</button></div>`;
  if (!state.metrics) return `<div class="loading-text">Зчитуємо стан системи…</div>`;
  const metrics = state.metrics;
  const queue = metrics.queue || {};
  return `<div class="system-grid"><div class="metric-card accent"><span class="metric-label">ВИКОНУЮТЬСЯ ЗАРАЗ</span><div class="metric-number">${number(queue.running, 0)}<small>розрахунків</small></div><span class="metric-detail">Активні обчислювальні задачі</span></div><div class="metric-card"><span class="metric-label">ОЧІКУЮТЬ У ЧЕРЗІ</span><div class="metric-number">${number(queue.queued, 0)}<small>розрахунків</small></div><span class="metric-detail">Черга безпосередньо в PostgreSQL</span></div><div class="metric-card"><span class="metric-label">ЦІЛЬОВА КІЛЬКІСТЬ ВОРКЕРІВ</span><div class="metric-number">${number(metrics.desiredWorkers, 0)}<small>із 4</small></div><span class="metric-detail">Автоматичне масштабування 2–4</span></div></div><section class="panel"><div class="panel-head"><div><h2>Обчислювальні вузли</h2><p>Оновлення кожні 5 секунд · heartbeat у PostgreSQL</p></div><span class="status-label completed">${(metrics.nodes || []).filter(node => Date.now() - new Date(node.last_seen).getTime() < 20000).length} онлайн</span></div><div class="node-grid">${(metrics.nodes || []).map(node => { const online = Date.now() - new Date(node.last_seen).getTime() < 20000; return `<div class="node-card"><div class="node-card-head"><span>${icons(node.kind === 'api' ? 'server' : 'activity')}${escapeHtml(node.id)}</span><i class="status-dot ${online ? 'online' : 'offline'}" title="${online ? 'Онлайн' : 'Немає свіжого heartbeat'}"></i></div><div class="node-meta"><span>${escapeHtml(node.kind)} · ${node.active_job_id ? 'Обробляє задачу' : 'Очікує роботу'}</span><span>CPU ${number(node.cpu_percent, 1)}%</span><span>${number(node.memory_mb, 0)} МБ</span></div></div>`; }).join('') || '<div class="loading-text">Вузли ще не надіслали heartbeat</div>'}</div></section><div class="analytics-grid"><section class="panel"><div class="panel-head"><h2>Підсумок виконання</h2>${icons('check')}</div><div class="panel-body"><div class="settings-stat"><span>Успішно завершено</span><strong>${number(queue.completed, 0)}</strong></div><div class="settings-stat"><span>Помилки</span><strong>${number(queue.failed, 0)}</strong></div><div class="settings-stat"><span>Скасовано</span><strong>${number(queue.cancelled, 0)}</strong></div><div class="settings-stat"><span>Середній час обробки</span><strong>${number(metrics.averageSeconds, 2)} с</strong></div></div></section><section class="panel"><div class="panel-head"><h2>Як розподіляється робота</h2>${icons('branch')}</div><div class="system-explanation"><strong>Python-балансер</strong> спрямовує запит до API з меншою кількістю активних з’єднань. Обидва сервери працюють з однією базою.<br><br><strong>Воркери</strong> атомарно забирають задачі з PostgreSQL. Блокування рядків із пропуском уже зайнятих задач дозволяє обробляти різні розрахунки паралельно.</div></section></div>`;
}

async function checkHealth(notify = false) {
  try {
    const data = await api('/api/health');
    state.health = data;
    state.healthError = data.database === 'disconnected' || data.status === 'error';
    document.querySelector('#health-label').textContent = data.server || 'API онлайн';
    document.querySelector('#health-dot').className = `status-dot ${state.healthError ? 'offline' : 'online'}`;
    document.querySelector('#side-db-dot').className = `status-dot ${state.healthError ? 'offline' : 'online'}`;
    document.querySelector('#side-db-label').textContent = state.healthError ? 'База даних недоступна' : 'PostgreSQL підключено';
    if (notify) toast(`Запит обробив ${data.server}. PostgreSQL: ${data.database === 'connected' || data.database === 'ok' ? 'підключено' : data.database || 'доступно'}.`);
  } catch (error) {
    state.healthError = true;
    document.querySelector('#health-label').textContent = 'Немає зв’язку';
    document.querySelector('#health-dot').className = 'status-dot offline';
    document.querySelector('#side-db-dot').className = 'status-dot offline';
    document.querySelector('#side-db-label').textContent = 'Сервер недоступний';
    if (notify) toast(error.message, true);
  }
}

async function refreshJobs(notify = false) {
  if (!state.user || refreshBusy) return;
  refreshBusy = true;
  try {
    const { jobs } = await api('/api/jobs');
    state.jobs = jobs || [];
    const counter = document.querySelector('#nav-job-count');
    if (counter) { counter.textContent = state.jobs.length; counter.hidden = !state.jobs.length; }
    if (state.page === 'history') document.querySelector('#history-list')?.replaceChildren(fragment(historyCards()));
    if (state.selectedJob && !terminal(state.selectedJob.status)) {
      const summary = state.jobs.find(job => job.id === state.selectedJob.id);
      if (summary && terminal(summary.status)) await fetchJob(summary.id);
      else if (summary) { state.selectedJob = { ...state.selectedJob, ...summary }; if (state.page === 'workspace') renderJobArea(); }
    }
    if (!state.selectedJob) {
      const active = state.jobs.find(job => !terminal(job.status));
      if (active) { state.selectedJob = active; subscribeJob(active.id); if (state.page === 'workspace') renderJobArea(); }
    }
    if (notify) toast('Історію оновлено');
  } catch (error) { if (notify) toast(error.message, true); }
  finally { refreshBusy = false; }
}

function fragment(html) { const template = document.createElement('template'); template.innerHTML = html; return template.content; }

async function refreshMetrics() {
  if (!state.user || state.user.role.toLowerCase() !== 'admin' || metricsBusy) return;
  metricsBusy = true;
  try { state.metrics = await api('/api/admin/metrics'); state.metricsError = ''; }
  catch (error) { state.metricsError = error.message; }
  finally { metricsBusy = false; }
  if (state.page === 'system') document.querySelector('#system-content')?.replaceChildren(fragment(systemContent()));
}

async function fetchJob(id) {
  const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
  state.selectedJob = job;
  if (terminal(job.status)) closeStream();
  if (state.page === 'workspace') renderJobArea();
  return job;
}

function closeStream() { state.stream?.close(); state.stream = null; state.liveJobId = null; }

function subscribeJob(id) {
  if (state.liveJobId === id && state.stream) return;
  closeStream();
  if (!state.token) return;
  state.liveJobId = id;
  const stream = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events?token=${encodeURIComponent(state.token)}`);
  state.stream = stream;
  stream.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      const job = payload.job || payload;
      if (state.selectedJob?.id === id) {
        state.selectedJob = { ...state.selectedJob, ...job };
        if (state.page === 'workspace') renderJobArea();
      }
      if (terminal(job.status)) {
        closeStream();
        fetchJob(id).catch(error => toast(error.message, true));
        refreshJobs();
        if (job.status === 'completed') toast('Розклад готовий. Перегляньте результат оптимізації.');
      }
    } catch {}
  };
  stream.onerror = () => { stream.close(); if (state.stream === stream) { state.stream = null; state.liveJobId = null; } };
}

function validateForm() {
  const input = state.form;
  if (!input.name) throw new Error('Додайте назву розрахунку.');
  if (!input.tasks.length || input.tasks.length > 80) throw new Error('У плані має бути від 1 до 80 задач.');
  if (input.resources.length < 2 || input.resources.length > 8) throw new Error('Оберіть від 2 до 8 виконавців.');
  const ids = new Set(input.tasks.map(row => row.id));
  const resources = new Set(input.resources.map(row => row.id));
  for (const row of input.tasks) {
    if (!row.name) throw new Error(`Вкажіть назву задачі ${row.id}.`);
    if (!Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 1000) throw new Error(`Тривалість ${row.id} має бути більшою за 0 та не перевищувати 1000 годин.`);
    if (!Number.isFinite(row.deadline) || row.deadline < 0) throw new Error(`Вкажіть коректний дедлайн для ${row.id}.`);
    for (const dependency of row.dependencies) if (!ids.has(dependency) || dependency === row.id) throw new Error(`Перевірте залежності ${row.id}: ${dependency}.`);
    for (const resource of row.eligibleResources || []) if (!resources.has(resource)) throw new Error(`Ресурс ${resource} у задачі ${row.id} відсутній у плані.`);
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Залежності утворюють цикл. Кожна задача має залежати лише від попередніх робіт.');
    if (visited.has(id)) return;
    visiting.add(id);
    input.tasks.find(row => row.id === id).dependencies.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  }
  input.tasks.forEach(row => visit(row.id));
}

async function runOptimization() {
  if (state.running) return;
  syncForm();
  try { validateForm(); } catch (error) { toast(error.message, true); return; }
  if (!state.user) { state.pendingRun = true; openAuth(); return; }
  state.running = true;
  const button = document.querySelector('[data-action="run"]');
  if (button) { button.disabled = true; button.innerHTML = `${icons('spark')}<span>Створюємо розрахунок…</span>`; }
  try {
    const { job } = await api('/api/jobs', { method: 'POST', body: copy(state.form) });
    state.selectedJob = job;
    state.scheduleMode = 'optimized';
    state.jobs.unshift(job);
    renderJobArea();
    subscribeJob(job.id);
    document.querySelector('#job-area')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    refreshJobs();
  } catch (error) { toast(error.message, true); }
  finally { state.running = false; if (button?.isConnected) { button.disabled = false; button.innerHTML = `${icons('spark')}<span>Оптимізувати розклад</span>${icons('arrow')}`; } }
}

async function cancelJob(id) {
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    if (state.selectedJob?.id === id) { state.selectedJob = { ...state.selectedJob, ...job }; renderJobArea(); closeStream(); }
    toast('Запит на скасування прийнято');
    refreshJobs();
  } catch (error) { toast(error.message, true); }
}

function openAuth(mode = 'login') {
  state.authMode = mode;
  renderAuth();
  if (!dialog.open) dialog.showModal();
}

function renderAuth() {
  const register = state.authMode === 'register';
  dialog.innerHTML = `<button class="auth-close" data-action="close-auth" aria-label="Закрити">${icons('close')}</button><div class="auth-brand"><span class="brand-mark"><b></b><b></b><b></b></span>tempo</div><h2 class="auth-title" id="auth-title">${register ? 'Почнімо планувати.' : 'Раді бачити вас знову.'}</h2><p class="auth-subtitle">${register ? 'Створіть обліковий запис, щоб зберігати розрахунки та повертатися до результатів.' : 'Ваші плани, розрахунки та результати — в одному просторі.'}</p><form id="auth-form">${register ? '<label class="auth-field" for="auth-name">ВАШЕ ІМ’Я</label><input class="auth-input" id="auth-name" name="name" required maxlength="80" autocomplete="name" placeholder="Як до вас звертатися?">' : ''}<label class="auth-field" for="auth-email">ЕЛЕКТРОННА ПОШТА</label><input class="auth-input" id="auth-email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"><label class="auth-field" for="auth-password">ПАРОЛЬ</label><input class="auth-input" id="auth-password" name="password" type="password" required minlength="8" maxlength="128" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="Щонайменше 8 символів"><p class="auth-error" id="auth-error" role="alert"></p><button type="submit" class="run-button" ${state.authBusy ? 'disabled' : ''}>${register ? 'Створити обліковий запис' : 'Увійти в Tempo'} ${icons('arrow')}</button></form><p class="auth-switch">${register ? 'Уже маєте обліковий запис?' : 'Ще немає облікового запису?'}<button data-action="auth-switch">${register ? 'Увійти' : 'Зареєструватися'}</button></p><div class="auth-demo"><p>Демонстраційний доступ для перевірки проєкту</p><div class="button-row"><button class="text-button" data-demo="student">Увійти як користувач ${icons('arrow')}</button><button class="text-button" data-demo="admin">Адміністратор ${icons('arrow')}</button></div></div>`;
}

async function authenticate(payload, register = false) {
  if (state.authBusy) return;
  state.authBusy = true;
  const button = document.querySelector('#auth-form button[type="submit"]');
  if (button) button.disabled = true;
  document.querySelector('#auth-error').textContent = '';
  try {
    const { token, user } = await api(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: payload });
    state.token = token;
    state.user = user;
    localStorage.setItem('tempo-token', token);
    dialog.close();
    document.querySelector('#profile-area').innerHTML = profileMarkup();
    await refreshJobs();
    if (state.page === 'history' || state.page === 'system') renderPage();
    if (state.page === 'system') refreshMetrics();
    toast(`Вітаємо, ${user.name || user.email}!`);
    if (state.pendingRun) { state.pendingRun = false; await runOptimization(); }
  } catch (error) { document.querySelector('#auth-error').textContent = error.message; }
  finally { state.authBusy = false; if (button?.isConnected) button.disabled = false; }
}

function signOut(notify = true) {
  closeStream();
  state.token = '';
  state.user = null;
  state.jobs = [];
  state.selectedJob = null;
  state.metrics = null;
  localStorage.removeItem('tempo-token');
  document.querySelector('#profile-area').innerHTML = profileMarkup();
  document.querySelector('#nav-job-count').hidden = true;
  renderPage();
  if (notify) toast('Ви вийшли з облікового запису');
}

function navigate(page) {
  if (state.page === 'workspace') syncForm();
  state.page = page;
  state.mobileOpen = false;
  document.querySelector('.sidebar').classList.remove('mobile-open');
  location.hash = page;
  renderPage();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (page === 'history') refreshJobs();
  if (page === 'system') refreshMetrics();
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field="duration"]')) { syncForm(); updateSummary(); }
});

app.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]');
  if (nav) { navigate(nav.dataset.nav); return; }
  const preset = event.target.closest('[data-preset]');
  if (preset) { state.form = copy(presets[preset.dataset.preset].input); state.preset = preset.dataset.preset; renderPage(); return; }
  const filter = event.target.closest('[data-filter]');
  if (filter) { state.historyFilter = filter.dataset.filter; renderPage(); return; }
  const remove = event.target.closest('[data-remove-task]');
  if (remove) {
    syncForm();
    state.form.tasks = state.form.tasks.filter(row => row.id !== remove.dataset.removeTask).map(row => ({ ...row, dependencies: row.dependencies.filter(id => id !== remove.dataset.removeTask) }));
    state.preset = '';
    renderPage();
    return;
  }
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) { cancelJob(cancel.dataset.cancel); return; }
  const view = event.target.closest('[data-view-job]');
  if (view) {
    try { const job = await fetchJob(view.dataset.viewJob); state.scheduleMode = 'optimized'; navigate('workspace'); if (!terminal(job.status)) subscribeJob(job.id); document.querySelector('#job-area').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const schedule = event.target.closest('[data-schedule]');
  if (schedule) { state.scheduleMode = schedule.dataset.schedule; renderJobArea(); return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'health') checkHealth(true);
  if (action === 'menu') { state.mobileOpen = !state.mobileOpen; document.querySelector('.sidebar').classList.toggle('mobile-open', state.mobileOpen); }
  if (action === 'close-menu') { state.mobileOpen = false; document.querySelector('.sidebar').classList.remove('mobile-open'); }
  if (action === 'auth') { syncForm(); state.pendingRun = false; openAuth(); }
  if (action === 'profile') signOut();
  if (action === 'switch-admin') { signOut(false); openAuth(); }
  if (action === 'run') runOptimization();
  if (action === 'refresh-history') refreshJobs(true);
  if (action === 'refresh-metrics') refreshMetrics();
  if (action === 'export') { syncForm(); downloadJson(state.form, 'tempo-plan.json'); toast('План збережено у JSON'); }
  if (action === 'import') document.querySelector('#import-file').click();
  if (action === 'resource-minus' || action === 'resource-plus') {
    syncForm();
    if (action === 'resource-plus' && state.form.resources.length < 8) { const id = `R${Math.max(0, ...state.form.resources.map(row => Number(row.id.slice(1)) || 0)) + 1}`; state.form.resources.push({ id, name: `Виконавець ${state.form.resources.length + 1}` }); }
    if (action === 'resource-minus' && state.form.resources.length > 2) { const resource = state.form.resources.pop(); state.form.tasks.forEach(row => { if (row.eligibleResources) row.eligibleResources = row.eligibleResources.filter(id => id !== resource.id); }); }
    state.preset = '';
    renderPage();
  }
  if (action === 'add-task') {
    syncForm();
    if (state.form.tasks.length >= 80) { toast('Максимум — 80 задач в одному плані.', true); return; }
    const id = `T${Math.max(0, ...state.form.tasks.map(row => Number(row.id.slice(1)) || 0)) + 1}`;
    state.form.tasks.push({ id, name: 'Нова задача', duration: 4, deadline: 24, dependencies: [] });
    state.preset = '';
    renderPage();
    const row = document.querySelector(`tr[data-task="${id}"]`);
    row?.querySelector('.task-name').focus();
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

dialog.addEventListener('click', event => {
  if (event.target === dialog) { dialog.close(); state.pendingRun = false; return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'close-auth') { dialog.close(); state.pendingRun = false; }
  if (action === 'auth-switch') { state.authMode = state.authMode === 'login' ? 'register' : 'login'; renderAuth(); }
  const demo = event.target.closest('[data-demo]');
  if (demo) authenticate({ email: `${demo.dataset.demo}@tempo.local`, password: 'TempoDemo2026!' });
});

dialog.addEventListener('submit', event => {
  if (event.target.id !== 'auth-form') return;
  event.preventDefault();
  const data = new FormData(event.target);
  authenticate(Object.fromEntries(data.entries()), state.authMode === 'register');
});

dialog.addEventListener('cancel', () => { state.pendingRun = false; });

document.querySelector('#import-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Файл плану має бути меншим за 1 МБ.');
    const input = JSON.parse(await file.text());
    if (!Array.isArray(input.tasks) || !Array.isArray(input.resources)) throw new Error('Файл має містити масиви tasks та resources.');
    if (input.tasks.length > 80 || input.resources.length > 8) throw new Error('План перевищує ліміт: 80 задач і 8 виконавців.');
    const previous = state.form;
    state.form = { name: String(input.name || 'Імпортований план').slice(0, 120), resources: input.resources.map(row => ({ id: String(row.id), name: String(row.name || row.id).slice(0, 60) })), tasks: input.tasks.map(row => ({ id: String(row.id), name: String(row.name || row.id).slice(0, 100), duration: Number(row.duration), deadline: Number(row.deadline ?? 0), dependencies: Array.isArray(row.dependencies) ? row.dependencies.map(String) : [], eligibleResources: Array.isArray(row.eligibleResources) ? row.eligibleResources.map(String) : [] })), iterations: Math.max(1000, Math.min(2000000, Number(input.iterations) || 200000)), seed: Number(input.seed) || 42 };
    try { validateForm(); } catch (error) { state.form = previous; throw error; }
    state.preset = '';
    state.page = 'workspace';
    location.hash = 'workspace';
    renderPage();
    toast('План імпортовано. Параметри можна редагувати.');
  } catch (error) { toast(`Не вдалося імпортувати: ${error.message}`, true); }
  finally { event.target.value = ''; }
});

window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (['workspace', 'history', 'system'].includes(page) && page !== state.page) navigate(page); });

async function initialize() {
  const page = location.hash.slice(1);
  if (['workspace', 'history', 'system'].includes(page)) state.page = page;
  shell();
  checkHealth();
  if (state.token) {
    try { const { user } = await api('/api/auth/me'); state.user = user; document.querySelector('#profile-area').innerHTML = profileMarkup(); await refreshJobs(); if (state.page !== 'workspace') renderPage(); if (state.page === 'system') refreshMetrics(); }
    catch { state.token = ''; localStorage.removeItem('tempo-token'); }
  }
  setInterval(() => { if (document.hidden) return; if (state.user && (state.page === 'history' || state.selectedJob && !terminal(state.selectedJob.status) || state.jobs.some(job => !terminal(job.status)))) refreshJobs(); if (state.selectedJob && !terminal(state.selectedJob.status) && !state.stream) subscribeJob(state.selectedJob.id); }, 2500);
  setInterval(() => { if (!document.hidden && state.page === 'system') refreshMetrics(); }, 5000);
  setInterval(() => { if (!document.hidden) checkHealth(); }, 20000);
}

initialize();

