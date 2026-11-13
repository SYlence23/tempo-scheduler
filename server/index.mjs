import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, limits } from './config.mjs';
import { pool, query, initializeDatabase } from './db.mjs';
import { hashPassword, verifyPassword, createToken, requireAuth, requireAdmin } from './auth.mjs';
import { seedDemo } from './initialize.mjs';
import { validateInput } from './optimizer.mjs';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Served-By', config.serverId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });
const terminal = status => ['completed','failed','cancelled'].includes(status);
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const authAttempts = new Map();

function authRateLimit(req, res, next) {
  const now = Date.now();
  for (const [key, entry] of authAttempts) if (now - entry.start > 60000) authAttempts.delete(key);
  const key = req.ip;
  const entry = authAttempts.get(key) || { start: now, count: 0 };
  if (++entry.count > 40) return res.status(429).json({ error: 'Забагато спроб. Спробуйте за хвилину.' });
  authAttempts.set(key, entry);
  next();
}

async function health(req, res) {
  await query('SELECT 1');
  res.json({ status: 'ok', server: config.serverId, database: 'connected', timestamp: new Date().toISOString(), limits });
}
app.get(['/api/health','/health'], route(health));

app.post('/api/auth/register', authRateLimit, route(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;
  if (name.length < 2 || name.length > 80) throw invalid('Ім’я має містити від 2 до 80 символів.');
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Введіть коректну електронну адресу.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw invalid('Пароль має містити від 8 до 128 символів.');
  const passwordHash = await hashPassword(password);
  try {
    const { rows } = await query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,name,email,role', [randomUUID(),name,email,passwordHash]);
    res.status(201).json({ user: rows[0], token: createToken(rows[0]) });
  } catch (error) {
    if (error.code === '23505') throw invalid('Обліковий запис із цією адресою вже існує.', 409);
    throw error;
  }
}));

app.post('/api/auth/login', authRateLimit, route(async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = req.body.password;
  if (typeof password !== 'string' || password.length > 128 || email.length > 200) throw invalid('Некоректні дані входу.');
  const { rows } = await query('SELECT * FROM users WHERE email=$1', [email]);
  if (!rows[0] || !await verifyPassword(password, rows[0].password_hash)) throw invalid('Неправильна адреса або пароль.', 401);
  const user = publicUser(rows[0]);
  res.json({ user, token: createToken(user) });
}));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

async function estimates(jobs) {
  if (!jobs.some(job => job.status === 'queued')) return jobs;
  const [{ rows: queued }, { rows: workers }, { rows: running }] = await Promise.all([
    query("SELECT id,input FROM jobs WHERE status='queued' ORDER BY created_at,id"),
    query("SELECT count(*)::int AS count FROM nodes WHERE kind='worker' AND last_seen>now()-interval '12 seconds'"),
    query("SELECT input,progress,started_at FROM jobs WHERE status='running'")
  ]);
  const capacity = Math.max(1, workers[0].count);
  const duration = input => Math.min(config.timeoutSeconds * 1000, 1000 + (input?.iterations || 100000) * (input?.tasks?.length || 12) ** 2 * 0.000007);
  const availability = running.map(job => {
    const elapsed = Math.max(0, Date.now() - new Date(job.started_at).getTime());
    const progress = Math.max(0, Math.min(99, job.progress));
    return Math.max(1000, progress > 5 ? elapsed * (100-progress) / progress : duration(job.input)-elapsed);
  });
  while (availability.length < capacity) availability.push(0);
  const positions = new Map(queued.map((job, index) => {
    const next = Math.min(...availability);
    const slot = availability.indexOf(next);
    availability[slot] += duration(job.input);
    return [job.id, { queue_position: index+1, estimated_wait_seconds: Math.ceil(next / 1000) }];
  }));
  return jobs.map(job => job.status !== 'queued' ? job : { ...job, ...(positions.get(job.id) || { queue_position: null, estimated_wait_seconds: null }) });
}

async function findJob(req) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw invalid('Розрахунок не знайдено.', 404);
  const { rows } = await query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw invalid('Розрахунок не знайдено.', 404);
  if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') throw invalid('Немає доступу до цього розрахунку.', 403);
  return rows[0];
}

app.post('/api/jobs', requireAuth, route(async (req, res) => {
  let input;
  try { input = validateInput(req.body); } catch (error) { throw invalid(error.message); }
  if (input.tasks.length > config.maxTasks || input.resources.length > config.maxResources || input.iterations > config.maxIterations) throw invalid('Перевищено налаштовані ліміти розрахунку.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const { rows: counts } = await client.query("SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND status IN ('queued','running')", [req.user.id]);
    if (counts[0].count >= config.maxActiveJobs) throw invalid(`Максимум ${config.maxActiveJobs} активних розрахунків. Зачекайте або скасуйте один.`, 429);
    const { rows } = await client.query('INSERT INTO jobs(id,user_id,name,input,handled_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [randomUUID(),req.user.id,input.name,JSON.stringify(input),config.serverId]);
    await client.query("SELECT pg_notify('tempo_jobs',$1)", [rows[0].id]);
    await client.query('COMMIT');
    res.status(201).json({ job: (await estimates(rows))[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

app.get('/api/jobs', requireAuth, route(async (req, res) => {
  const { rows } = await query('SELECT * FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ jobs: await estimates(rows) });
}));
app.get('/api/jobs/:id', requireAuth, route(async (req, res) => res.json({ job: (await estimates([await findJob(req)]))[0] })));

app.post('/api/jobs/:id/cancel', requireAuth, route(async (req, res) => {
  const job = await findJob(req);
  if (terminal(job.status)) throw invalid('Розрахунок уже завершено.', 409);
  const { rows } = await query("UPDATE jobs SET status='cancelled',cancel_requested=true,stage='Скасовано користувачем',completed_at=now(),execution_ms=CASE WHEN started_at IS NULL THEN 0 ELSE (extract(epoch FROM(now()-started_at))*1000)::int END WHERE id=$1 AND status IN ('queued','running') RETURNING *", [job.id]);
  if (!rows[0]) throw invalid('Розрахунок завершився до скасування.', 409);
  res.json({ job: rows[0] });
}));

app.get('/api/jobs/:id/events', requireAuth, route(async (req, res) => {
  let job = await findJob(req);
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  let closed = false;
  let busy = false;
  let previous = '';
  const send = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const { rows } = await query('SELECT * FROM jobs WHERE id=$1', [job.id]);
      if (!rows[0]) return res.end();
      job = (await estimates(rows))[0];
      const snapshot = JSON.stringify(job);
      if (snapshot !== previous && !closed) { res.write(`data: ${snapshot}\n\n`); previous = snapshot; }
      if (terminal(job.status)) res.end();
    } catch { if (!closed) res.end(); } finally { busy = false; }
  };
  const timer = setInterval(() => void send(), 750);
  const ping = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 15000);
  res.once('close', () => { closed = true; clearInterval(timer); clearInterval(ping); });
  await send();
}));

app.get('/api/jobs/:id/download', requireAuth, route(async (req, res) => {
  const job = await findJob(req);
  if (job.status !== 'completed' || !job.result) throw invalid('Результат ще не готовий.', 409);
  res.setHeader('Content-Disposition', `attachment; filename="tempo-${job.id}.json"`);
  res.type('json').send(JSON.stringify({ name: job.name, input: job.input, result: job.result, worker: job.worker_id, executionMs: job.execution_ms }, null, 2));
}));

app.get('/api/admin/metrics', requireAuth, requireAdmin, route(async (req, res) => {
  const [{ rows: counts }, { rows: nodes }, { rows: average }, { rows: desired }] = await Promise.all([
    query('SELECT status,count(*)::int AS count FROM jobs GROUP BY status'),
    query("SELECT * FROM nodes WHERE last_seen>now()-interval '15 seconds' ORDER BY kind,id"),
    query("SELECT avg(execution_ms)::float AS duration FROM (SELECT execution_ms FROM jobs WHERE status='completed' ORDER BY completed_at DESC LIMIT 20) recent"),
    query("SELECT value FROM settings WHERE key='desired_workers'")
  ]);
  const queue = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const row of counts) queue[row.status] = row.count;
  res.json({ queue, nodes, averageSeconds: Math.round((average[0].duration || 0) / 100) / 10, desiredWorkers: Number(desired[0]?.value || 2), limits });
}));

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не знайдено.' }));
app.get(['/', '/history', '/admin'], (req, res) => res.sendFile(fileURLToPath(new URL('../public/index.html', import.meta.url))));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Надто великий запит.' });
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Некоректний JSON.' });
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Сервер тимчасово недоступний. Спробуйте ще раз.' : error.message });
});

await initializeDatabase();
await seedDemo();
let previousCpu = process.cpuUsage();
let previousTime = performance.now();
async function heartbeat() {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const percent = ((cpu.user-previousCpu.user)+(cpu.system-previousCpu.system)) / ((now-previousTime)*10);
  previousCpu = cpu;
  previousTime = now;
  await query("INSERT INTO nodes(id,kind,last_seen,cpu_percent,memory_mb) VALUES($1,'api',now(),$2,$3) ON CONFLICT(id) DO UPDATE SET last_seen=now(),cpu_percent=$2,memory_mb=$3", [config.serverId,Math.min(100,Math.max(0,percent)),process.memoryUsage().rss/1024/1024]);
}
await heartbeat();
const heartbeats = setInterval(() => heartbeat().catch(error => console.error(error.message)), 2000);
const server = app.listen(config.port, config.host, () => console.log(`${config.serverId} listening on http://${config.host}:${config.port}`));
const connections = new Set();
server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
async function shutdown() {
  clearInterval(heartbeats);
  server.close();
  for (const socket of connections) socket.destroy();
  await query('DELETE FROM nodes WHERE id=$1', [config.serverId]).catch(() => {});
  await pool.end();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
