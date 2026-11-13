import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInput } from '../backend/validation.mjs';

const fixture=()=>({name:'Plan',resources:[{id:'r',name:'Resource'}],tasks:[{id:'a',duration:1,deadline:3,dependencies:[]},{id:'b',duration:2,deadline:5,dependencies:['a']}],iterations:1000,seed:42});
test('API validates DAG, limits and resource eligibility before enqueueing Python work',()=>{
  const data=fixture();
  assert.equal(validateInput(data).tasks[1].eligibleResources[0],'r');
  data.tasks[0].dependencies=['b'];
  assert.throws(()=>validateInput(data),/цикл/);
  assert.throws(()=>validateInput({...fixture(),iterations:2000001}),/ітерацій/);
  assert.throws(()=>validateInput({...fixture(),tasks:[{id:'a',duration:1,eligibleResources:['missing']},fixture().tasks[1]]}),/невідомого/);
  assert.throws(()=>validateInput({...fixture(),tasks:[{id:'a',duration:.0001},fixture().tasks[1]]}),/0,001/);
});

test('API preserves clock display in saved input and rejects malformed times', () => {
  const data = validateInput({...fixture(), startTime:'09:30', timeDisplay:'clock'});
  assert.equal(data.startTime, '09:30');
  assert.equal(data.timeDisplay, 'clock');
  assert.equal(data.tasks[1].deadline, 5);
  assert.equal(validateInput(fixture()).startTime, undefined);
  for (const startTime of ['24:00', '12:60', '9:00', null]) assert.throws(()=>validateInput({...fixture(),startTime}), /ГГ:ХХ/);
  assert.throws(()=>validateInput({...fixture(),timeDisplay:'calendar'}), /формат/);
});
