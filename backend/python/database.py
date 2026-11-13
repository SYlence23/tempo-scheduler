import time
import psycopg
from psycopg.rows import dict_row
from psycopg.conninfo import conninfo_to_dict
from .config import DATABASE_URL, ROOT

def connect(url=None):
    dsn = url or DATABASE_URL
    options = conninfo_to_dict(dsn).get('options', '') + ' -c statement_timeout=5000'
    return psycopg.connect(dsn, autocommit=True, row_factory=dict_row, connect_timeout=5, options=options)

def initialize(connection):
    connection.execute('SELECT pg_advisory_lock(740001)')
    try:
        connection.execute((ROOT / 'backend' / 'schema.sql').read_text(encoding='utf-8'))
    finally:
        connection.execute('SELECT pg_advisory_unlock(740001)')

def wait_for_database():
    failure = None
    for attempt in range(30):
        try:
            connection = connect()
            initialize(connection)
            return connection
        except (psycopg.Error, OSError) as error:
            failure = error
            time.sleep(1)
    raise RuntimeError('PostgreSQL is not available') from failure
