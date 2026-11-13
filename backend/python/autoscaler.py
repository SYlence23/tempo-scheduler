import signal
import time
import psycopg
from psycopg.types.json import Jsonb
from .config import STOP_FILE
from .database import wait_for_database

def scale_decision(current, running, queued, idle_since, now):
    if queued:
        return max(current, max(2, min(4, running+queued))), None
    if running > 2 or current == 2:
        return current, None
    idle_since = now if idle_since is None else idle_since
    return (2 if now-idle_since >= 20 else current), idle_since

def main():
    connection = wait_for_database()
    stopping, idle_since = False, None
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print('[autoscaler] Python, PostgreSQL, 2–4 воркери.', flush=True)
    try:
        while not stopping and not STOP_FILE.exists():
            try:
                connection.execute("""
                    UPDATE jobs SET status='cancelled',stage='Скасовано користувачем',completed_at=now()
                    WHERE status='running' AND cancel_requested=true AND heartbeat_at<now()-interval '25 seconds'
                """)
                connection.execute("""
                    UPDATE jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
                        stage=CASE WHEN attempts<3 THEN 'Повторно в черзі після втрати воркера' ELSE 'Втрачено з’єднання з воркером' END,
                        worker_id=NULL,progress=0,heartbeat_at=NULL,
                        error=CASE WHEN attempts>=3 THEN 'Воркер не відповів після трьох спроб.' ELSE NULL END,
                        completed_at=CASE WHEN attempts>=3 THEN now() ELSE NULL END
                    WHERE status='running' AND cancel_requested=false AND heartbeat_at<now()-interval '25 seconds'
                """)
                counts = {row['status']: row['count'] for row in connection.execute("SELECT status,count(*) AS count FROM jobs WHERE status IN ('queued','running') GROUP BY status").fetchall()}
                setting = connection.execute("SELECT value FROM settings WHERE key='desired_workers'").fetchone()
                current = max(2, min(4, int(setting['value'] if setting else 2)))
                desired, idle_since = scale_decision(current, counts.get('running', 0), counts.get('queued', 0), idle_since, time.monotonic())
                connection.execute("INSERT INTO settings(key,value) VALUES('desired_workers',%s) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", (Jsonb(desired),))
                if desired != current:
                    print(f'[autoscaler] {current} → {desired}', flush=True)
            except psycopg.Error as error:
                print(f'[autoscaler] {error}', flush=True)
                connection.close()
                connection = wait_for_database()
            for _ in range(10):
                if stopping or STOP_FILE.exists():
                    break
                time.sleep(.2)
    finally:
        connection.close()

if __name__ == '__main__':
    main()
