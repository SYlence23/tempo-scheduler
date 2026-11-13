import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines() if (ROOT / '.env').exists() else []:
    key, separator, value = line.partition('=')
    if separator and key.strip() and not key.lstrip().startswith(chr(35)):
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))

DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql://tempo:tempo_local_demo@127.0.0.1:55432/tempo')
WORKER_ID = os.environ.get('WORKER_ID') or 'WORKER_1'
WORKER_SLOT = int(os.environ.get('WORKER_SLOT') or '1')
TIMEOUT_SECONDS = int(os.environ.get('TASK_TIMEOUT_SECONDS') or '120')
RUNTIME = Path(os.environ.get('TEMPO_RUNTIME') or ROOT / '.runtime')
STOP_FILE = RUNTIME / 'stop.request'
if not 1 <= TIMEOUT_SECONDS <= 600:
    raise ValueError('Invalid TASK_TIMEOUT_SECONDS')
