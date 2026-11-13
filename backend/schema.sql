CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage text NOT NULL DEFAULT 'Очікує в черзі',
  input jsonb NOT NULL,
  result jsonb,
  worker_id text,
  handled_by text,
  error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  execution_ms integer,
  heartbeat_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (created_at,id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status);

CREATE TABLE IF NOT EXISTS nodes (
  id text PRIMARY KEY,
  kind text NOT NULL,
  active_job_id uuid,
  last_seen timestamptz NOT NULL DEFAULT now(),
  cpu_percent real NOT NULL DEFAULT 0,
  memory_mb real NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO settings(key,value) VALUES ('desired_workers','2') ON CONFLICT DO NOTHING;
