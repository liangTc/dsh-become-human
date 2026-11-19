import './test-dependencies.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const {ControlJournal}=await import('../plugins/become-human/driver.mjs');
const {DomainMemory}=await import('../plugins/become-human/domain.mjs');
const {AutonomyStore}=await import('../plugins/become-human/autonomy-store.mjs');
const {SafetyLedger}=await import('../plugins/become-human/safety.mjs');
const {CognitionStore}=await import('../plugins/become-human/cognition.mjs');
const {RemoteGateway}=await import('../plugins/become-human-web/remote.mjs');
const {EventLog}=await import('../plugins/become-human/event-log.mjs');
const {runDevelopmentReview}=await import('../plugins/become-human/development-runtime.mjs');
const journal=new ControlJournal(':memory:'),id='budget-test';journal.ensure(id);
const domain=new DomainMemory(journal),store=new AutonomyStore(journal,domain);
const budget={quotaEnabled:true,windowStart:1000,windowEnd:Date.now()+60000,tokenLimit:600000,reservedTokens:590000,requestLimit:96,requests:2,roundLimit:48,rounds:1,roundIds:['development:test']};
store.budget=()=>budget;
journal.put(id,'developmentReview',{id:'development:test',status:'waiting-budget'});
store.requestBudget(id,'development:test',{tokens:280000,requests:1});
store.requestBudget(id,'development:test',{tokens:280000,requests:1});
const request=store.snapshot(id).pendingBudgetRequest;
assert.equal(request.suggestedTokens,270000);assert.equal(request.suggestedRounds,0);
const model={provider:'fixture',model:'fixture'},neededModel=createHash('sha256').update(JSON.stringify(model)).digest('hex');
journal.put(id,'developmentReview',{id:'development:test',status:'waiting-budget',neededTokens:280000,neededModel,personaEnabled:false,batchId:null});
const oldSettings=store.settings.bind(store);store.settings=()=>({...oldSettings(id),enabled:true});
let prepared=0;
const reviewAgent={id,inbox:{nextTurn:[],nextStep:[]},desired:()=>({epoch:1,desired:'running'}),session:{},ctx:{sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall(){prepared++;throw Error('must not dispatch');}}},factory:{journal,domain,autonomy:store,memoryLifecycle:{settings:()=>({enabled:false}),due:()=>({due:false})},personaDevelopment:{due:()=>false,snapshot:()=>({version:1,currentTraits:[]})},management:{options:()=>model,profile:()=>({name:'Fixture',interests:[]})}}};
assert.equal(await runDevelopmentReview(reviewAgent,new AbortController().signal),false);
assert.equal(await runDevelopmentReview(reviewAgent,new AbortController().signal),false);
assert.equal(prepared,0);assert.equal(journal.value(id,'developmentReview').status,'waiting-budget');
const feed=()=>journal.db.prepare('SELECT * FROM outbox WHERE agent=? ORDER BY seq').all(id);
assert.equal(feed().length,1);assert.equal(feed()[0].kind,'budget-request');
const state={sessionId:id,desired:'running',messages:[],autonomy:{pendingBudgetRequest:request}};
let stateReads=0;
// A notice may be published after the tick reads state but before it reads
// the outbox. Advancing the cursor against that stale snapshot would lose it.
const runtime={state:async()=>++stateReads===1?{...state,autonomy:{pendingBudgetRequest:null}}:state,events:async after=>({sessionId:id,events:feed().filter(row=>row.seq>after)})};
const gateway=new RemoteGateway(':memory:',runtime,{seal:x=>x,unseal:x=>x});
let sends=0;gateway.register('fixture',{verify:async()=>({privateOwner:true}),send:async(_cfg,text)=>{assert.match(text,/\[系统\]/);sends++;return {accepted:true};}});
gateway.db.prepare('INSERT INTO channel VALUES(?,?,?,1,?,0,NULL)').run('fixture-channel','fixture',JSON.stringify({ownerId:'fixture-owner'}),id);
await gateway.tick();await gateway.tick();assert.equal(sends,1);
assert.equal(gateway.db.prepare('SELECT state FROM delivery').get().state,'sent');
// A queued system notice can outlive its request while another delivery is in flight.
const oldDelivery=gateway.db.prepare('SELECT * FROM delivery').get();
gateway.db.prepare("UPDATE delivery SET state='pending',payload=?").run('[系统] previous request');
journal.put(id,'developmentReview',{id:'development:test',status:'completed'});
assert.equal(store.snapshot(id).pendingBudgetRequest,null);
const next=store.requestBudget(id,'new-task',{tokens:280000,requests:1});
assert.notEqual(next.id,request.id);assert.equal(feed().length,1);
state.autonomy.pendingBudgetRequest=store.pendingBudgetRequest(id);
await gateway.tick();assert.equal(sends,1);
assert.equal(gateway.db.prepare('SELECT state FROM delivery WHERE seq=?').get(oldDelivery.seq).state,'discarded');
await gateway.close();journal.close();

const rollingJournal=new ControlJournal(':memory:'),rollingId='rolling-human';
rollingJournal.ensure(rollingId);
const rolling=new AutonomyStore(rollingJournal,new DomainMemory(rollingJournal));
const originalClock=Date.now;let clock=Date.UTC(2026,10,19,8);
try{
  Date.now=()=>clock;
  rollingJournal.put(rollingId,'autonomySettings',{budgetWindow:'rolling-day',tokenLimit:1024});
  const request=rolling.requestBudget(rollingId,'new-task',{tokens:2024,requests:1});
  clock++;
  assert.equal(rolling.snapshot(rollingId).pendingBudgetRequest.id,request.id);
  const again=rolling.requestBudget(rollingId,'new-task',{tokens:2124,requests:1});
  assert.equal(again.id,request.id);assert.equal(again.expiresAt,request.expiresAt);
  assert.equal(again.noticeSeq,request.noticeSeq);assert.equal(again.suggestedTokens,1100);
  rollingJournal.put(rollingId,'developmentReview',{id:'development:queued',status:'waiting-budget'});
  const other=rolling.requestBudget(rollingId,'development:queued',{tokens:3024,requests:1});
  assert.equal(other.id,request.id);assert.equal(rolling.pendingBudgetRequest(rollingId).taskId,'new-task');
  rollingJournal.put(rollingId,'autonomySettings',{budgetWindow:'rolling-day',tokenLimit:1500});
  assert.equal(rolling.snapshot(rollingId).pendingBudgetRequest.suggestedTokens,624);
  assert.equal(rollingJournal.db.prepare("SELECT count(*) n FROM outbox").get().n,1);
  // Upgrade a legacy, already announced rolling request without issuing another notice.
  const {noticeSeq,noticeKey,roundId,...legacy}=again;
  const key='autonomy-budget-notice:'+legacy.windowStart;
  rollingJournal.db.prepare('UPDATE outbox SET event_key=? WHERE seq=?').run(key,noticeSeq);
  rollingJournal.put(rollingId,'autonomyBudgetRequest',legacy);
  const upgraded=rolling.requestBudget(rollingId,'new-task',{tokens:2200,requests:1});
  assert.equal(upgraded.id,legacy.id);assert.equal(upgraded.noticeSeq,noticeSeq);assert.equal(upgraded.noticeKey,key);
  clock=upgraded.expiresAt;assert.equal(rolling.pendingBudgetRequest(rollingId),null);
  const renewed=rolling.requestBudget(rollingId,'new-task',{tokens:2200,requests:1});
  assert.notEqual(renewed.id,request.id);assert.equal(rollingJournal.db.prepare("SELECT count(*) n FROM outbox").get().n,2);
  const grants=[];
  rollingJournal.safety={budget:{entries:new Map()},autonomyPolicy:()=>null,autonomyAgents:()=>new Set([rollingId]),autonomyEntries:()=>[],autonomyGrants:()=>grants,
    prepare:async(_key,kind,data)=>{if(kind==='autonomy-grant')grants.push(data);}};
  await rolling.grant(rollingId,{mode:'once',tokens:100,requests:0,days:1});
  assert.equal(rolling.pendingBudgetRequest(rollingId).id,renewed.id);
  assert.equal(rolling.pendingBudgetRequest(rollingId).suggestedTokens,600);
  await rolling.configure(rollingId,{tokenLimit:2100});
  assert.equal(rolling.pendingBudgetRequest(rollingId),null);
}finally{Date.now=originalClock;rollingJournal.close();}

// Replay the signed instruction format directly in SQLite. No DPAPI or
// production credentials are needed to exercise recovery of the read indexes.
const day=86400000,fixtureClock=Date.UTC(2026,10,19,8),owner='current',oldOwner='prior';
const ledger=new SafetyLedger(':memory:');
ledger.key=Buffer.alloc(32,1);ledger.db=new DatabaseSync(':memory:');
ledger.db.exec('CREATE TABLE instruction(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,kind TEXT,request_hash TEXT,data TEXT,previous TEXT,hash TEXT,phase TEXT)');
ledger.reload();
const liveJournal=new ControlJournal(':memory:');liveJournal.ensure(owner);liveJournal.safety=ledger;
const live=new AutonomyStore(liveJournal,new DomainMemory(liveJournal));
const cognition=new CognitionStore(liveJournal,live.domain,{factory:{autonomy:live}});
let noticeSends=0,time=fixtureClock;const notices=[];
Date.now=()=>time;
const currentState=()=>({sessionId:owner,desired:'running',autonomy:{pendingBudgetRequest:live.pendingBudgetRequest(owner)}});
const remote=new RemoteGateway(':memory:',{state:async()=>currentState(),events:async after=>({sessionId:owner,events:liveJournal.db.prepare('SELECT * FROM outbox WHERE agent=? AND seq>? ORDER BY seq').all(owner,after)})},{seal:value=>value,unseal:value=>value});
try{
  ledger.appendSync('policy','autonomy-policy',{agent:owner,settings:{budgetWindow:'rolling-day',quotaEnabled:true,tokenLimit:1024}});
  // Includes retired lineage, a released reservation, out-of-order timestamps,
  // a previous grant/revocation and missing timestamps in an old budget row.
  const reserve=(rid,agent,amount,created)=>ledger.appendSync('reserve:'+rid,'budget-reserve',{rid,agent,amount,budgetClass:'autonomous',created});
  reserve('later',owner,300,time-day+4);
  reserve('earlier',oldOwner,600,time-day+1);
  reserve('released',owner,800,time-day+8);ledger.releaseBudget('released');
  ledger.appendSync('legacy','budget-reserve',{rid:'legacy',agent:oldOwner,amount:20});
  ledger.appendSync('transition','retire',{oldId:oldOwner,newId:owner});
  ledger.appendSync('grant','autonomy-grant',{id:'g',agent:owner,created:time-day,expires:time+day,tokens:180,requests:0});
  ledger.appendSync('revoke','autonomy-grant-revoke',{id:'g',agent:owner});
  const restarted=new SafetyLedger(':memory:');restarted.key=ledger.key;restarted.db=ledger.db;restarted.reload();
  liveJournal.safety=restarted;assert.equal(restarted.used(),920);
  const original=live.requestBudget(owner,'new-task',{tokens:950,requests:1});
  assert.equal(original.suggestedTokens,826);
  assert.equal(live.pendingBudgetRequest(owner).suggestedTokens,826);
  assert(cognition.gates(owner,{now:time}).reasons.includes('budget-wait'));
  remote.register('fixture',{verify:async()=>({privateOwner:true}),send:async(_cfg,payload)=>{noticeSends++;notices.push(payload);return {accepted:true};}});
  remote.db.prepare('INSERT INTO channel VALUES(?,?,?,1,?,0,NULL)').run('bound','fixture','{}',owner);
  time+=2;
  assert.equal(live.pendingBudgetRequest(owner).suggestedTokens,226);
  assert.equal(live.snapshot(owner).pendingBudgetRequest.suggestedTokens,226);
  await remote.tick();assert.equal(noticeSends,1);assert.match(notices[0],/226 token/);assert.doesNotMatch(notices[0],/826 token/);
  // An already queued notice must be discarded when both reservations slide out.
  remote.db.prepare("UPDATE delivery SET state='pending',payload='original notice'").run();
  time+=3;
  assert.equal(live.pendingBudgetRequest(owner),null);assert.equal(live.snapshot(owner).pendingBudgetRequest,null);
  assert(!cognition.gates(owner,{now:time}).reasons.includes('budget-wait'));
  await remote.tick();assert.equal(noticeSends,1);assert.equal(remote.db.prepare('SELECT state FROM delivery').get().state,'discarded');
  // Inspect a large, already verified history, only one entry in the window.
  const historical=restarted.budget.entries;
  for(let index=0;index<180000;index++){const rid='past-'+index;historical.set(rid,{agent:owner,rid,status:'settled',amount:1,budgetClass:'autonomous',created:index+1});}
  historical.set('fresh',{agent:owner,rid:'fresh',status:'settled',amount:75,budgetClass:'autonomous',created:time});
  restarted.indexBudgetEntries();
  historical.values=()=>{throw Error('unexpected historical scan while reading budget');};
  const budget=live.budget(owner);assert.equal(budget.requests,1);assert.equal(budget.reservedTokens,75);
  assert.equal(restarted.latestBudgetTime(owner),time);
  console.log('PASS: rolling expiry, repriced and withdrawn IM notices, signed replay and indexed 180000-entry history');
}finally{Date.now=originalClock;await remote.close();liveJournal.close();ledger.close();}
const db=new DatabaseSync(':memory:'),log=new EventLog(db);
log.append(id,'start','dispatch',{attemptId:'r1',taskId:'t1'});
log.append(id,'end','attempt-failed',{attemptId:'r1',error:'EMPTY_MODEL_OUTPUT'});
log.append(id,'budget','model-preparation-rejected',{code:'AUTONOMOUS_BUDGET_EXHAUSTED'});
assert.equal(log.query(id,{status:'running'}).total,0);
assert.equal(log.query(id,{status:'submitted'}).total,1);
assert.equal(log.query(id,{status:'wait'}).total,1);
assert.equal(log.query(id,{status:'failed'}).total,1);
assert.equal(log.task(id,'t1')[0].status,'submitted');
assert.equal(db.prepare("SELECT status FROM human_event WHERE kind='dispatch'").get().status,'running');
db.close();
console.log('PASS: pending requests survive rolling accounting windows, refresh and legacy upgrade; explicit expiry renews identity; fresh amounts, stale delivery suppression and one mocked receipt verified.');
