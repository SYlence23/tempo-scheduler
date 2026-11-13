import concurrent.futures
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb
from backend.python.autoscaler import scale_decision
from backend.python.database import connect
from backend.python.supervisor import normalize_desired
from backend.python.worker import claim_next_job

ROOT=pathlib.Path(__file__).resolve().parent.parent

class ScalingTests(unittest.TestCase):
    def test_capacity_is_bounded_and_scales_after_idle_period(self):
        for raw,expected in [(None,2),(1,2),(9,4),('3',3),(3.5,2)]:
            self.assertEqual(normalize_desired(raw),expected)
        self.assertEqual(scale_decision(2,2,10,None,0),(4,None))
        self.assertEqual(scale_decision(4,2,0,None,10),(4,10))
        self.assertEqual(scale_decision(4,2,0,10,30),(2,10))
        self.assertEqual(scale_decision(4,3,0,10,30),(4,None))

@unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'),'TEST_DATABASE_URL is required')
class PostgreSQLWorkerTests(unittest.TestCase):
    def setUp(self):
        self.schema='tempo_python_test_'+uuid.uuid4().hex
        self.admin=connect(os.environ['TEST_DATABASE_URL'])
        self.admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(self.schema)))
        self.dsn=make_conninfo(os.environ['TEST_DATABASE_URL'],options=f'-c search_path={self.schema}')
        self.connection=connect(self.dsn)

    def tearDown(self):
        self.connection.close()
        self.admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(self.schema)))
        self.admin.close()

    def test_atomic_claim_skips_locks_and_never_assigns_a_job_twice(self):
        self.connection.execute("""
            CREATE TABLE jobs(id uuid PRIMARY KEY,status text DEFAULT 'queued',progress integer DEFAULT 0,
                stage text,worker_id text,started_at timestamptz,heartbeat_at timestamptz,
                attempts integer DEFAULT 0,cancel_requested boolean DEFAULT false,created_at timestamptz DEFAULT now())
        """)
        ids=[uuid.uuid4() for _ in range(24)]
        for job_id in ids:
            self.connection.execute('INSERT INTO jobs(id) VALUES(%s)',(job_id,))
        cancelled=uuid.uuid4()
        self.connection.execute('INSERT INTO jobs(id,cancel_requested) VALUES(%s,true)',(cancelled,))
        self.connection.execute("UPDATE jobs SET created_at=now()-interval '1 minute' WHERE id=%s",(ids[0],))
        locker=connect(self.dsn)
        try:
            with locker.transaction():
                locker.execute('SELECT id FROM jobs WHERE id=%s FOR UPDATE',(ids[0],))
                first=claim_next_job(self.connection,'locked-check')
                self.assertNotEqual(first['id'],ids[0])
        finally:
            locker.close()
        def claim(index):
            connection=connect(self.dsn)
            try:
                return claim_next_job(connection,f'claim-{index}')
            finally:
                connection.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
            claimed=[first]+[job for job in executor.map(claim,range(40)) if job]
        self.assertEqual(len(claimed),24)
        self.assertEqual(len({job['id'] for job in claimed}),24)
        self.assertTrue(all(job['status']=='running' and job['attempts']==1 for job in claimed))
        self.assertIsNone(claim_next_job(self.connection,'extra'))
        self.assertEqual(self.connection.execute('SELECT status FROM jobs WHERE id=%s',(cancelled,)).fetchone()['status'],'queued')

    def test_actual_python_worker_hard_timeout_then_processes_next_job(self):
        self.connection.execute((ROOT/'backend/schema.sql').read_text(encoding='utf-8'))
        user_id,first_id,second_id=uuid.uuid4(),uuid.uuid4(),uuid.uuid4()
        self.connection.execute("INSERT INTO users(id,name,email,password_hash) VALUES(%s,'Test',%s,'unused')",(user_id,f'{user_id}@test.local'))
        data={'name':'Timeout','resources':[{'id':f'r{i}'} for i in range(4)],'tasks':[{'id':f't{i}','duration':1+i%9,'deadline':20+i%30,'dependencies':[]} for i in range(80)],'iterations':2000000,'seed':42}
        self.connection.execute('INSERT INTO jobs(id,user_id,name,input) VALUES(%s,%s,%s,%s)',(first_id,user_id,data['name'],Jsonb(data)))
        with tempfile.TemporaryDirectory(prefix='tempo-python-timeout-') as runtime:
            environment=dict(os.environ,DATABASE_URL=self.dsn,TEMPO_RUNTIME=runtime,TASK_TIMEOUT_SECONDS='1',WORKER_ID='TIMEOUT_TEST',WORKER_SLOT='1',PYTHONUTF8='1',PYTHONUNBUFFERED='1')
            child=subprocess.Popen([sys.executable,'-m','backend.python.worker'],cwd=ROOT,env=environment,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            def wait_for(job_id,status):
                deadline=time.monotonic()+15
                while time.monotonic()<deadline:
                    row=self.connection.execute('SELECT * FROM jobs WHERE id=%s',(job_id,)).fetchone()
                    if row and row['status']==status:
                        return row
                    if child.poll() is not None:
                        raise AssertionError(child.stdout.read().decode('utf-8',errors='replace'))
                    time.sleep(.1)
                raise AssertionError(f'Job did not reach {status}')
            try:
                failed=wait_for(first_id,'failed')
                self.assertIn('ліміт виконання 1 с',failed['error'])
                self.assertIsNone(failed['result'])
                self.assertEqual(failed['attempts'],1)
                self.assertGreaterEqual(failed['execution_ms'],900)
                self.assertLess(failed['execution_ms'],5000)
                small=dict(data,name='After timeout',tasks=data['tasks'][:4],iterations=1000)
                self.connection.execute('INSERT INTO jobs(id,user_id,name,input) VALUES(%s,%s,%s,%s)',(second_id,user_id,small['name'],Jsonb(small)))
                completed=wait_for(second_id,'completed')
                self.assertEqual(completed['progress'],100)
                self.assertEqual(completed['result']['iterations'],1000)
                self.assertIn('Python',completed['result']['algorithm'])
            finally:
                pathlib.Path(runtime,'stop.request').write_text('stop',encoding='utf-8')
                try:
                    child.wait(5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(5)
                child.stdout.close()

if __name__=='__main__':
    unittest.main()
