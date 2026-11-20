import assert from 'node:assert/strict';
import {ControlJournal} from '../plugins/become-human/driver.mjs';
import {runStatus} from '../plugins/become-human/run-status.mjs';
import {RemoteGateway} from '../plugins/become-human-web/remote.mjs';

const journal=new ControlJournal(':memory:');
try{
  const agent='sample',insert=journal.db.prepare('INSERT INTO attempt(id,agent,state,request,started) VALUES(?,?,?,?,?)');
  const add=(id,state,ids,at)=>insert.run(id,agent,state,JSON.stringify({admittedIds:ids}),at);
  add('old','failed',['superseded'],1);add('ok','completed',['superseded'],2);
  add('active','failed',['forgotten','second','third'],3);add('partial','completed',['third'],4);
  const usable=id=>id!=='forgotten';
  const payload=JSON.stringify({messages:[{text:'x'.repeat(25000)}]});
  journal.transaction(()=>{for(let i=0;i<1800;i++)insert.run('auto-'+i,agent,'wait',payload,i+5);});
  const start=performance.now();
  assert.deepEqual(journal.retryInputIds(agent,usable),['second']);
  const indexedMs=performance.now()-start;
  const before=performance.now();for(const row of journal.db.prepare('SELECT request FROM attempt WHERE agent=? ORDER BY started DESC').iterate(agent))JSON.parse(row.request);
  const scanMs=performance.now()-before;
  add('final','completed',['second'],2000);assert.deepEqual(journal.retryInputIds(agent,usable),[]);
  add('aa-failure','failed',['same-ms'],2100);add('zz-success','completed',['same-ms'],2100);
  assert.deepEqual(journal.retryInputIds(agent,usable),[]);
  console.log(JSON.stringify({attempts:1804,fullScanMs:Math.round(scanMs),indexedMs:+indexedMs.toFixed(2)}));
}finally{journal.close();}

const daytime=Date.parse('2026-11-19T17:00:00+08:00'),night=Date.parse('2026-11-19T23:00:00+08:00');
const settings={enabled:true,quietStart:22,quietEnd:8,timeZoneOffsetMinutes:480},state={desired:'running',nextTickAt:daytime+600000,autonomy:{settings}};
assert.match(runStatus(state,daytime).text,/聊天在线.*自主待机.*17:10/);
assert.match(runStatus(state,night).text,/安静时段.*11-20 08:00/);
assert.match(runStatus({...state,autonomy:{settings,paused:true,error:'MODEL_EXECUTION_FAILED'}},night).text,/聊天在线.*自主保护暂停.*MODEL_EXECUTION_FAILED/);
assert.equal(runStatus({...state,desired:'paused'},night).nextCheckAt,null);
assert.match(runStatus({...state,autonomy:{settings,pendingBudgetRequest:{id:'test'}}},daytime).activity,/补额/);
const retryUntil=daytime+1200000;
const cooling={...state,autonomy:{settings,modelRetryAt:retryUntil}};
assert.match(runStatus(cooling,daytime).text,/聊天在线.*下次自动检查.*17:20/);
assert.match(runStatus(cooling,retryUntil).activity,/自主待机/);
assert.equal(runStatus({...cooling,autonomy:{...cooling.autonomy,paused:true}},daytime).nextCheckAt,null);
console.log('PASS retry visibility, superseded inputs, source withdrawal and shared run status');

const protectedState={...state,sessionId:'fixture-human',autonomy:{settings,paused:true,error:'MODEL_EXECUTION_FAILED'}};
const reported=runStatus(protectedState,daytime);
const runtime={async state(mode){assert.equal(mode,'runtime-status');return {...protectedState,run:reported};}};
const gateway=new RemoteGateway(':memory:',runtime,{seal:value=>value,unseal:value=>value});
try{
  gateway.db.prepare('INSERT INTO channel VALUES(?,?,?,1,?,0,NULL)').run('fixture-phone','telegram',JSON.stringify({ownerId:'owner'}),protectedState.sessionId);
  const input={text:'/status',senderId:'owner',chatId:'owner',privateChat:true,messageId:'status-once'};
  const response=await gateway.receive('fixture-phone',input);
  assert.equal(response.description,reported.text);assert.equal(response.sessionId,protectedState.sessionId);
  assert.deepEqual(await gateway.receive('fixture-phone',input),{duplicate:true});
  console.log('PASS bound IM status uses lightweight state, includes protective pause and deduplicates delivery');
}finally{await gateway.close();}
