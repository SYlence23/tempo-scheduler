import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from .config import ROOT, RUNTIME, STOP_FILE, TIMEOUT_SECONDS
from .database import wait_for_database

def normalize_desired(value):
    try:
        parsed = float(value)
        return max(2, min(4, int(parsed))) if parsed.is_integer() else 2
    except (TypeError, ValueError, OverflowError):
        return 2

def main():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    connection = wait_for_database()
    if not connection.execute('SELECT pg_try_advisory_lock(740002) AS acquired').fetchone()['acquired']:
        connection.close()
        print('[supervisor] Інший супервізор уже працює.', flush=True)
        return
    children = {}
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    def persist():
        snapshot = {'supervisorPid': os.getpid(), 'updatedAt': datetime.now(timezone.utc).isoformat(), 'children': [{'pid': state['process'].pid, 'workerId': f'WORKER_{slot}', 'slot': slot, 'startedAt': state['startedAt']} for slot, state in children.items()]}
        temporary = RUNTIME / 'supervisor-children.json.tmp'
        temporary.write_text(json.dumps(snapshot, indent=2), encoding='utf-8')
        temporary.replace(RUNTIME / 'supervisor-children.json')
    def drain(slot, state):
        if not state.get('draining'):
            (RUNTIME / f'drain-WORKER_{slot}.request').write_text('drain', encoding='utf-8')
            state['draining'] = time.monotonic()
            print(f'[supervisor] WORKER_{slot}: очікування завершення роботи.', flush=True)
    print('[supervisor] Резервні Python-процеси WORKER_3/4 за попитом.', flush=True)
    persist()
    try:
        while not stopping and not STOP_FILE.exists():
            for slot, state in list(children.items()):
                if state['process'].poll() is not None:
                    del children[slot]
                    (RUNTIME / f'drain-WORKER_{slot}.request').unlink(missing_ok=True)
                    persist()
            setting = connection.execute("SELECT value FROM settings WHERE key='desired_workers'").fetchone()
            desired = normalize_desired(setting['value'] if setting else 2)
            for slot in (3, 4):
                state = children.get(slot)
                if slot <= desired and state is None:
                    worker_id = f'WORKER_{slot}'
                    foreign = connection.execute("SELECT id FROM nodes WHERE id=%s AND last_seen>now()-interval '12 seconds'", (worker_id,)).fetchone()
                    if foreign:
                        continue
                    (RUNTIME / f'drain-{worker_id}.request').unlink(missing_ok=True)
                    environment = dict(os.environ, WORKER_ID=worker_id, WORKER_SLOT=str(slot), PYTHONUNBUFFERED='1', PYTHONUTF8='1')
                    process = subprocess.Popen([sys.executable, '-m', 'backend.python.worker'], cwd=ROOT, env=environment, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    children[slot] = {'process': process, 'startedAt': datetime.now(timezone.utc).isoformat()}
                    print(f'[supervisor] Запущено {worker_id}, Python PID {process.pid}.', flush=True)
                    persist()
                elif slot > desired and state:
                    drain(slot, state)
            time.sleep(.5)
    finally:
        for slot, state in children.items():
            drain(slot, state)
        deadline = time.monotonic()+TIMEOUT_SECONDS+20
        while children and time.monotonic() < deadline:
            for slot, state in list(children.items()):
                if state['process'].poll() is not None:
                    del children[slot]
                    (RUNTIME / f'drain-WORKER_{slot}.request').unlink(missing_ok=True)
            if children:
                time.sleep(.2)
        for state in children.values():
            state['process'].terminate()
            state['process'].wait(5)
        children.clear()
        persist()
        connection.close()

if __name__ == '__main__':
    main()
