import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool, query } from '../backend/db.mjs';

const base = process.env.TEMPO_TEST_URL || 'http://127.0.0.1:8088';
const password = 'TempoTest2026!';
const makeInput = (count = 12, iterations = 20000) => ({
  name: 'Інтеграційна перевірка', resources: Array.from({length:4},(_,i)=>({id:`r${i+1}`,name:`Ресурс ${i+1}`})),
  tasks: Array.from({length:count},(_,i)=>({id:`t${i+1}`,name:`Задача ${i+1}`,duration:2+(i*7)%11,deadline:15+i,dependencies:i>3&&i%3===0?[`t${i-2}`]:[]})),
  iterations, seed:42
});
async function request(path, token, options = {}) {
  const response = await fetch(`${base}${path}`,{...options, headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...options.headers}});
  const data = await response.json();
  return {response,data};
}

test('Tempo: two APIs, authentication, real optimization, SSE, ownership, download, atomic limits and cancellation', {timeout:60000}, async () => {
  const createdUsers = [];
  try {
    const servers = new Set();
    for (let i=0;i<12;i++) {
      const {response,data} = await request('/api/health');
      assert.equal(response.status,200);
      assert.equal(data.database,'connected');
      servers.add(response.headers.get('x-served-by'));
      assert.ok(response.headers.get('x-handled-by'));
      assert.equal(response.headers.get('x-balancer'),'Python-least_conn');
    }
    assert.deepEqual([...servers].sort(),['API_1','API_2']);
    const register = async () => {
      const {response,data} = await request('/api/auth/register',null,{method:'POST',body:JSON.stringify({name:'Тестовий користувач',email:`test-${randomUUID()}@tempo.local`,password})});
      assert.equal(response.status,201);
      createdUsers.push(data.user.id);
      return data;
    };
    const first = await register();
    const second = await register();
    const login = await request('/api/auth/login',null,{method:'POST',body:JSON.stringify({email:first.user.email,password})});
    assert.equal(login.response.status,200);
    assert.equal(login.data.user.id,first.user.id);
    assert.equal((await request('/api/jobs')).response.status,401);
    assert.equal((await request('/api/admin/metrics',first.token)).response.status,403);
    const cyclic=makeInput();cyclic.tasks[0].dependencies=['t1'];
    assert.equal((await request('/api/jobs',first.token,{method:'POST',body:JSON.stringify(cyclic)})).response.status,400);
    const created=await request('/api/jobs',first.token,{method:'POST',body:JSON.stringify({...makeInput(),startTime:'09:30',timeDisplay:'clock'})});
    assert.equal(created.response.status,201);
    assert.equal(created.data.job.input.startTime,'09:30');
    assert.equal(created.data.job.input.timeDisplay,'clock');
    const id=created.data.job.id;
    assert.equal((await request(`/api/jobs/${id}`,second.token)).response.status,403);
    const stream=await fetch(`${base}/api/jobs/${id}/events?token=${encodeURIComponent(first.token)}`);
    assert.equal(stream.status,200);
    assert.match(stream.headers.get('content-type'),/text\/event-stream/);
    const reader=stream.body.getReader();
    let eventText='';
    const until=Date.now()+20000;
    while(Date.now()<until) {
      const chunk=await reader.read();
      if(chunk.done) break;
      eventText+=new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.match(eventText,/'completed'|"completed"/);
    let complete;
    for(let i=0;i<60;i++) {
      complete=(await request(`/api/jobs/${id}`,first.token)).data.job;
      if(['completed','failed'].includes(complete.status))break;
      await sleep(150);
    }
    assert.equal(complete.status,'completed',complete.error);
    assert.equal(complete.progress,100);
    assert.match(complete.result.algorithm,/Python/);
    assert.ok(complete.worker_id);
    assert.ok(complete.result.optimized.score<=complete.result.baseline.score+0.001);
    const schedule=complete.result.optimized.schedule;
    for(const task of complete.input.tasks) {
      const row=schedule.find(row=>row.taskId===task.id);
      assert.ok(task.eligibleResources.includes(row.resourceId));
      for(const dependency of task.dependencies)assert.ok(row.start>=schedule.find(other=>other.taskId===dependency).end-0.001);
    }
    for(const resource of complete.input.resources) {
      const rows=schedule.filter(row=>row.resourceId===resource.id).sort((a,b)=>a.start-b.start);
      for(let i=1;i<rows.length;i++)assert.ok(rows[i].start>=rows[i-1].end-0.001);
    }
    const download=await request(`/api/jobs/${id}/download`,first.token);
    assert.equal(download.response.status,200);
    assert.match(download.response.headers.get('content-disposition'),/attachment/);
    assert.equal(download.data.result.iterations,20000);
    const submissions=await Promise.all(Array.from({length:7},()=>request('/api/jobs',first.token,{method:'POST',body:JSON.stringify(makeInput(80,2000000))})));
    const accepted=submissions.filter(item=>item.response.status===201);
    assert.equal(accepted.length,6);
    assert.equal(submissions.filter(item=>item.response.status===429).length,1);
    for(const submission of accepted) {
      const cancellation=await request(`/api/jobs/${submission.data.job.id}/cancel`,first.token,{method:'POST'});
      assert.equal(cancellation.response.status,200);
      assert.equal(cancellation.data.job.status,'cancelled');
    }
    await sleep(1200);
    for(const submission of accepted) assert.equal((await request(`/api/jobs/${submission.data.job.id}`,first.token)).data.job.status,'cancelled');
    const admin=await request('/api/auth/login',null,{method:'POST',body:JSON.stringify({email:'admin@tempo.local',password:'TempoDemo2026!'})});
    assert.equal(admin.response.status,200);
    const metrics=await request('/api/admin/metrics',admin.data.token);
    assert.equal(metrics.response.status,200);
    assert.ok(metrics.data.nodes.filter(node=>node.kind==='api').length>=2);
    assert.ok(metrics.data.nodes.filter(node=>node.kind==='worker').length>=2);
    console.log('Verified: API_1+API_2 via Python least_conn; Python CPU optimizer; SQL queue; SSE; ownership; active-job limit; cancellation; admin metrics.');
  } finally {
    for(const id of createdUsers) {
      await query("UPDATE jobs SET status='cancelled',cancel_requested=true WHERE user_id=$1 AND status IN ('queued','running')",[id]);
      await query('DELETE FROM users WHERE id=$1',[id]);
    }
    await pool.end();
  }
});
