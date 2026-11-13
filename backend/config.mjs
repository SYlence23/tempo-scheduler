import 'dotenv/config';

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://tempo:tempo_local_demo@127.0.0.1:55432/tempo',
  jwtSecret: process.env.JWT_SECRET || 'tempo_local_development_secret_change_before_deployment_2026',
  serverId: process.env.SERVER_ID || 'API_1',
  workerId: process.env.WORKER_ID || 'WORKER_1',
  port: integer('PORT', 3101, 1, 65535),
  host: process.env.HOST || '127.0.0.1',
  maxActiveJobs: integer('MAX_ACTIVE_JOBS', 6, 1, 20),
  maxTasks: integer('MAX_TASKS', 80, 2, 80),
  maxResources: integer('MAX_RESOURCES', 8, 1, 8),
  maxIterations: integer('MAX_ITERATIONS', 2000000, 1000, 2000000),
  timeoutSeconds: integer('TASK_TIMEOUT_SECONDS', 120, 1, 600),
  minWorkers: 2,
  maxWorkers: 4,
  seedDemo: process.env.SEED_DEMO === 'true'
};

export const limits = {
  maxTasks: config.maxTasks,
  maxResources: config.maxResources,
  maxIterations: config.maxIterations,
  maxActiveJobs: config.maxActiveJobs,
  timeoutSeconds: config.timeoutSeconds
};
