import assert from 'node:assert/strict';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {resolveImHome} from '../plugins/become-human-web/im/plugin-src/host/im-home.mjs';
import {managementRequestError} from '../plugins/become-human-web/im/plugin-src/client/channels/weixin/api.js';
import {callManagementRpc} from '../plugins/become-human-web/im/plugin-src/management-rpc.mjs';
import {brainTimeline} from '../plugins/become-human/timeline.mjs';

const home=path.resolve('test-profile'),managed=path.join(home,'become-human-manager','im-home');
assert.equal(resolveImHome({profileContext:{home}},{},{}),managed);
assert.equal(resolveImHome({}, {dshHome:managed}, {}),managed);
assert.equal(resolveImHome({}, {}, {DSH_HOME:home}),managed);
assert.equal(resolveImHome({profileContext:{home}}, {}, {DSH_HOME:path.resolve('wrong-home')}),managed);
assert.throws(()=>resolveImHome({}, {}, {}),/INVALID_IM_HOME/);
assert.throws(()=>resolveImHome({}, {dshHome:'relative'}, {}),/INVALID_IM_HOME/);
for(const status of [401,403,404,500]){
  const connection={rpc:{call:async()=>{throw Object.assign(new Error('private server content'),{status});}}};
  let original;try{await callManagementRpc(connection,'/weixin','connection.status',{});}catch(error){original=error;}
  const visible=managementRequestError(original,'connection.status');
  assert.equal(visible.details.httpStatus,status);
  assert.equal(JSON.stringify(visible).includes('private server content'),false);
}
const abort=Object.assign(new Error('stop'),{name:'AbortError'});
assert.equal(managementRequestError(abort,'connection.status'),abort);

const db=new DatabaseSync(':memory:');
db.exec(`CREATE TABLE human_event(id TEXT,time INTEGER,kind TEXT,data TEXT,agent TEXT,task_id TEXT,request_id TEXT,round_id TEXT,status TEXT);
CREATE TABLE attempt(id TEXT,turn TEXT,state TEXT,started INTEGER,ended INTEGER,usage TEXT,error TEXT,request TEXT,agent TEXT);
CREATE TABLE memory_record(id TEXT,type TEXT,payload TEXT,truth TEXT,refs TEXT,status TEXT,version INTEGER,valid_from INTEGER,agent TEXT);
CREATE TABLE learning_note(id TEXT,data TEXT,agent TEXT,memory_id TEXT);`);
const t=Date.now()-10000,agent='test';let seq=0;
function event(kind,data={}){const id=String(++seq);db.prepare('INSERT INTO human_event VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL)').run(id,t+seq,kind,JSON.stringify(data),agent);return id;}
const maintained=event('memory-lifecycle-maintained',{changed:0});
event('memory-lifecycle-batch-proposed',{batchId:'done'});
event('memory-lifecycle-summary-committed',{batchId:'done'});
event('memory-lifecycle-batch-proposed',{batchId:'failed'});
event('memory-lifecycle-batch-failed',{batchId:'failed',code:'INVALID_SUMMARY'});
event('memory-lifecycle-batch-proposed',{batchId:'pending'});
const persona=event('persona-development-applied',{});
const management={journal:{db,value:()=>null},factory:{autonomy:{settings:()=>({timeZoneOffsetMinutes:480}),getTask:()=>null}}};
try{
  const result=brainTimeline(management,agent,{from:t,to:t+100,limit:50});
  const states=Object.fromEntries(result.items.map(item=>[item.id,item.status]));
  assert.equal(states['memory-event:'+maintained],'success');
  assert.equal(states['memory-batch:done'],'success');
  assert.equal(states['memory-batch:failed'],'failed');
  assert.equal(states['memory-batch:pending'],'wait');
  assert.equal(states['memory-event:'+persona],'success');
  assert.equal(result.items.filter(item=>item.status==='running').length,0);
  assert.equal(brainTimeline(management,agent,{from:t,to:t+100,status:'failed'}).items.length,1);
  console.log('PASS: profile without DSH_HOME, explicit directory, legacy compatibility, HTTP diagnostics, cancellation, and independent maintenance batch states.');
}finally{db.close();}
