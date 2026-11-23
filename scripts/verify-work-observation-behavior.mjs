import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ControlJournal,HumanFactory} from '../plugins/become-human/driver.mjs';
import {DomainMemory} from '../plugins/become-human/domain.mjs';
import {AutonomyStore} from '../plugins/become-human/autonomy-store.mjs';
import {BehaviorRegistry} from '../plugins/become-human/behaviors.mjs';
import {CognitionStore} from '../plugins/become-human/cognition.mjs';
import {WorkObservation} from '../plugins/become-human/work-observation.mjs';
import {createHostCapabilities} from '../plugins/become-human-web/host-capabilities.mjs';
import {runAutonomyTurn} from '../plugins/become-human/autonomy.mjs';
import {SafetyLedger} from '../plugins/become-human/safety.mjs';
import {ReminderStore} from '../plugins/become-human/reminders.mjs';
import {usageStatistics} from '../plugins/become-human/usage-statistics.mjs';
import {queueWorkObservation,registerWorkObservationBehaviors,restoreWorkObservation} from '../plugins/become-human/work-observation-runtime.mjs';

const id=randomUUID(),journal=new ControlJournal(':memory:');journal.ensure(id);
const domain=new DomainMemory(journal),autonomy=new AutonomyStore(journal,domain),behaviors=new BehaviorRegistry();
let now=Date.now(),enabled=true,badMode='transport',requests=0,hostCalls=0,listed=['one','two'],missing=[];
const bridge={sessionReadEnabled:true,sessionReadScope:'selected',readSessionIds:['one','two','three'],allowedSessionIds:['one','two','three']};
const workObservation=new WorkObservation(journal,{bridgeSettings:()=>bridge,clock:()=>now});
const factory={journal,domain,autonomy,behaviors,workObservation,tools:{configuration:()=>({bridge,revision:1})}};
factory.cognition=new CognitionStore(journal,domain,{factory,clock:()=>now});const agent={id,factory};
const agentSettings=workObservation.settings.bind(workObservation);
workObservation.settings=agentId=>({...agentSettings(agentId),enabled});
const updated=now;
let lastHint,hasUpdates=true;
const readHost=async(op,input)=>{
  hostCalls++;
  if(op==='dsh-session-list')return {items:listed.map(sessionId=>({sessionId})),verifiedVisibleSessionIds:listed,missingSessionIds:missing,hasMore:false};
  if(op==='dsh-work-update-hint'){lastHint=input;return {hasNewMessages:hasUpdates};}
  const {sessionId,afterSeq}=input;
  if(sessionId==='one'&&badMode==='transport')throw Error('DSH_SESSION_READ_UNAVAILABLE');
  const messages=afterSeq===-1?[{role:'user',seq:1,time:updated,text:'需要先核对合成任务的计划。'}]:[];
  return {sessionId,afterSeq,throughSeq:1,nextAfterSeq:1,prefixDigest:(sessionId==='one'?'a':'b').repeat(64),messages,hasMore:false};
};
registerWorkObservationBehaviors(factory,{readHost});
const offers=()=>behaviors.opportunities(agent,{now,events:[]});
const readTask=()=>{const tid=queueWorkObservation(agent);assert.equal(queueWorkObservation(agent),tid);return autonomy.getTask(tid);};
const request=async messages=>{
  requests++;const batch=JSON.parse(messages[1].content[0].text);
  const original=batch.units[0],invalid=badMode==='invalid';
  return {rid:randomUUID(),text:JSON.stringify({items:[{unitId:invalid?'missing-unit':original.unitId,category:'blocker'}]})};
};
const execute=async(task,signal=new AbortController().signal,model=request)=>{
  const result=await behaviors.execute(agent,task,{signal,valid:()=>signal.throwIfAborted(),request:model});
  autonomy.update(task.id,result.status==='completed'?'completed':'failed',task.checkpoint);return result;
};
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'work-observation-behavior-'));
async function verifySavedGrant(){
  const {Context}=await import('@deepseek-ai/cordis');
  const [sessions,agents,projections,jsonl,llm]=await Promise.all(['@deepseek-ai/dsh-session','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-session-projection','@deepseek-ai/dsh-session-persistence-jsonl','@deepseek-ai/dsh-llm'].map(name=>import(name).then(mod=>mod.default)));
  const ctx=new Context(),fibers=[];
  let ledger;
  try{
    for(const plugin of [sessions,agents,projections])fibers.push(await ctx.plugin(plugin));
    fibers.push(await ctx.plugin(jsonl,{root:path.join(tmp,'sessions'),compression:'none'}));
    fibers.push(await ctx.plugin(llm));
    fibers.push(await ctx.plugin(HumanFactory,{journal:path.join(tmp,'worker.sqlite'),provider:'fixture',model:'fixture'}));
    const f=ctx.becomeHuman,store=f.workObservation,session='fixture-work';
    f.journal.ensure(id);f.controllerSessionId=id;
    ledger=await SafetyLedger.open(path.join(tmp,'signed-policy'));f.journal.safety=ledger;
    const save=async ids=>{
      const {revision,...policy}=f.tools.configuration(id);
      await f.tools.configure(id,{...policy,bridge:{...policy.bridge,sessionReadEnabled:true,readSessionIds:ids}},revision);
    };
    const observe=()=>{
      const batch=store.stage(id,{sessionId:session,afterSeq:-1,throughSeq:1,nextAfterSeq:1,prefixDigest:'a'.repeat(64),messages:[{seq:1,role:'user',time:Date.now(),text:'合成进度记录。'}],hasMore:false});
      return store.commit(id,batch.id,{items:[{unitId:batch.model.units[0].unitId,category:'progress'}]}).items[0];
    };
    await save([session]);await store.configure(id,{enabled:true},0);
    const first=observe();assert.equal(store.get(id,first.id).valid,true);
    await save([]);assert.equal(store.get(id,first.id).status,'withdrawn');
    assert.throws(()=>queueWorkObservation({id,factory:f}),/WORK_OBSERVATION_NOT_AUTHORIZED/);
    await save([session]);assert.equal(store.context(id).length,0);
    const fresh=observe();assert.notEqual(fresh.id,first.id);assert.equal(store.context(id)[0].id,fresh.id);
    const policy=f.tools.configuration(id),revision=policy.revision;delete policy.revision;
    policy.bridge.readSessionIds=[];
    // Signed grant committed, followed by a process exit before SQLite cleanup.
    await f.journal.safety.prepare(randomUUID(),'human-capability-policy',{agent:id,revision:revision+1,settings:policy});
    restoreWorkObservation({id,factory:f});await save([session]);assert.equal(store.context(id).length,0);
  }finally{for(const fiber of fibers.reverse())await fiber.dispose();ledger?.close();}
}
async function verifyFollowups(){
  const owner=randomUUID();journal.ensure(owner);const person={id:owner,factory};
  const save=(session,seq,text,category,role='user')=>{
    const afterSeq=workObservation.cursor(owner,session).afterSeq;
    const batch=workObservation.stage(owner,{sessionId:session,afterSeq,throughSeq:seq,nextAfterSeq:seq,prefixDigest:'d'.repeat(64),messages:[{seq,time:now,role,text}],hasMore:false});
    return workObservation.commit(owner,batch.id,{items:[{unitId:batch.model.units[0].unitId,category}]}).items[0];
  };
  const call=(behaviorId,recordId,request)=>{
    const task={id:randomUUID(),checkpoint:{behaviorId,plan:{input:{recordId}}}};
    return behaviors.execute(person,task,{valid(){},signal:new AbortController().signal,request});
  };
  const issue=save('one',1,'白桦交付仍卡在签名。','blocker');
  const other=save('one',2,'还需要确认白桦海报的尺寸。','todo');
  save('two',1,'白桦签名齐了。','progress');
  save('one',3,'我想签名应该好了。','progress','assistant');
  assert.equal(workObservation.followupState(owner,issue).state,'open');
  const progress=save('one',4,'白桦交付所缺的签名已经补齐。','progress');
  assert.equal(workObservation.assistanceCandidate(owner),null);
  await call('offer-work-assistance',issue.id);
  assert.equal(journal.db.prepare('SELECT count(*) AS n FROM human_matter WHERE agent=?').get(owner).n,0);
  const compare=(subject,answer)=>call('review-work-followup',subject.id,async messages=>{
    const input=JSON.parse(messages[1].content[0].text);assert.equal(input.earlier.text,subject.text);
    assert.deepEqual(input.updates.map(r=>r.text),[progress.text]);return {rid:randomUUID(),text:JSON.stringify({resolvedBy:answer})};
  });
  await assert.rejects(()=>compare(issue,2),/INVALID_WORK_OBSERVATION_OUTPUT/);
  await compare(issue,1);await compare(other,null);
  const reopened=new WorkObservation(journal,{bridgeSettings:()=>bridge,clock:()=>now});reopened.settings=workObservation.settings;
  assert.equal(reopened.assistanceCandidate(owner).id,other.id);
  assert.equal(reopened.assistanceCandidate(owner,'review'),null);assert.equal(reopened.followupState(owner,issue).state,'resolved');
  assert.equal(reopened.get(owner,issue.id).text,issue.text);
  await call('offer-work-assistance',issue.id);await call('offer-work-assistance',other.id);
  assert.equal(journal.db.prepare('SELECT count(*) AS n FROM human_matter WHERE agent=?').get(owner).n,1);
  const changed=workObservation.correct(owner,progress.id,{expectedVersion:progress.version,annotation:'回执后来被撤回，需要重看。'});
  assert.equal(workObservation.followupState(owner,issue).state,'review');
  const pending=workObservation.followupState(owner,issue).pending;
  workObservation.forget(owner,changed.id,{expectedVersion:changed.version});
  assert.throws(()=>workObservation.commitFollowup(owner,issue,pending,1),/WORK_OBSERVATION_SOURCE_CHANGED/);
  assert.equal(workObservation.assistanceCandidate(owner).id,issue.id);
}
try{
  enabled=false;assert.equal(offers().length,0);assert.throws(readTask,/WORK_OBSERVATION_NOT_AUTHORIZED/);
  enabled=true;assert.deepEqual(offers().map(row=>row.behaviorId),['observe-work-sessions']);
  assert.equal(hostCalls,0);assert.equal(requests,0);
  const hintSignal=new AbortController().signal,ballot={checkpoint:{opportunities:offers()}};
  assert.equal(await workObservation.selectionHint(agent,{checkpoint:{}},hintSignal),undefined);
  enabled=false;assert.equal(await workObservation.selectionHint(agent,ballot,hintSignal),undefined);enabled=true;
  assert.equal(hostCalls,0);
  const hint=await workObservation.selectionHint(agent,ballot,hintSignal);
  assert.equal(hint.behaviorId,'observe-work-sessions');assert.deepEqual(Object.keys(hint).sort(),['behaviorId','signal']);
  assert.deepEqual(lastHint.cursors,[{sessionId:'one',afterSeq:-1},{sessionId:'two',afterSeq:-1}]);
  hasUpdates=false;assert.equal(await workObservation.selectionHint(agent,ballot,hintSignal),undefined);
  assert.equal(workObservation.cursor(id,'two').afterSeq,-1);assert.equal(requests,0);
  const event=(seq,kind)=>({seq,surfaceOp:'append',type:'user/message',data:{source:{kind},content:'外部原话'}});
  const inspected=[],host=createHostCapabilities({sessionController:{
    list:async()=>({items:['one','two','unlisted'].map(sessionId=>({sessionId}))}),
    inspect:async session=>{inspected.push(session);if(session==='one')throw Error('cannot read this fixture');return {meta:{id:session},events:[event(2,'user'),event(4,'injected')]};}
  }},{getHumanSessionId:()=>id});
  host.configure(bridge);
  const probe=cursors=>host.handle({operation:'dsh-work-update-hint',input:{cursors}});
  assert.deepEqual(await probe(lastHint.cursors),{hasNewMessages:true});
  assert.deepEqual(await probe([{sessionId:'two',afterSeq:2}]),{hasNewMessages:false});
  await assert.rejects(()=>probe([{sessionId:'unlisted',afterSeq:-1}]),/CAPABILITY_SCOPE_DENIED/);
  assert(!inspected.includes('unlisted'));await host.close();
  journal.safety=await SafetyLedger.open(path.join(tmp,'ledger'));
  await autonomy.configure(id,{enabled:true,quotaEnabled:false,quietStart:0,quietEnd:0});
  factory.config={provider:'synthetic',model:'synthetic',domainEnabled:true};
  factory.reminders=new ReminderStore(journal);factory.tickets=new WeakMap();factory.allowCall=async()=>{};
  const events=[];agent.session={id,snapshotEvents:()=>events,append(type,data){events.push({type,data,time:Date.now()});}};
  agent.inbox={nextStep:[],nextTurn:[]};agent.flush=async()=>{};agent.desired=()=>journal.get(id);
  journal.set(id,'running');journal.put(id,'remaining',null);
  let upstreamFailure;
  const lanes=[];agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall:async()=>({config:factory.config,async *stream({messages}){
    const data=JSON.parse(messages[1].content[0].text);lanes.push(data.units?'extract':'select');
    if(upstreamFailure){yield {type:'finish',reason:{kind:'error',failure:{message:upstreamFailure}}};return;}
    const response=await request(messages);yield {type:'text-delta',text:response.text};
    yield {type:'usage',usage:{inputTokens:20,outputTokens:6}};yield {type:'finish',reason:{kind:'stop'}};
  }})}};
  const first=readTask();
  await runAutonomyTurn(agent,new AbortController().signal);
  const finished=autonomy.getTask(first.id);
  assert.equal(finished.status,'completed',JSON.stringify(finished.checkpoint));assert.match(finished.checkpoint.behaviorResult.summary,/保存 1 条/);
  assert.deepEqual(lanes,['extract']);assert.equal(events.filter(row=>row.type==='turn/start').length,1);
  assert.equal(journal.db.prepare("SELECT count(*) AS n FROM attempt WHERE agent=? AND state='executed'").get(id).n,1);
  const usage=usageStatistics(factory,id).categories.find(row=>row.id==='work-observation');
  assert.equal(usage.autonomousRequests,1);assert.equal(usage.reportedTokens,26);
  assert.equal(requests,1);assert.equal(workObservation.sessionBlocked(id,'one'),true);
  assert.equal(workObservation.read(id).status.deferredSessions,1);
  assert.deepEqual(offers().map(row=>row.behaviorId),['offer-work-assistance']);
  assert.equal(journal.db.prepare("SELECT count(*) AS n FROM human_matter WHERE request_id LIKE 'work-observation:%'").get().n,0);
  const [offer]=offers();const fakeTask={id:randomUUID(),checkpoint:{...offer,plan:{input:offer.behaviorInput}}};
  await behaviors.execute(agent,fakeTask,{signal:new AbortController().signal,valid(){}});
  assert.equal(journal.db.prepare("SELECT count(*) AS n FROM human_matter WHERE request_id LIKE 'work-observation:%'").get().n,1);
  assert.equal(offers().length,0);
  now+=workObservation.settings(id).intervalMs;badMode='invalid';
  await execute(readTask());assert.equal(workObservation.read(id).status.heldSessions,1);
  assert.equal(workObservation.status(id).held,false);
  const failedBatch=journal.db.prepare("SELECT id FROM human_work_observation_batch WHERE agent=? AND session='one' AND status='failed'").get(id);
  workObservation.clearFault(id,'one');
  workObservation.noteStatus(id,{phase:'blocked',held:true,lastError:'INVALID_WORK_OBSERVATION_OUTPUT'});
  journal.audit(id,'work-observation-failed',{code:'INVALID_WORK_OBSERVATION_OUTPUT'});
  restoreWorkObservation(agent);assert.equal(workObservation.status(id).held,true,'unknown legacy hold must remain held');
  journal.audit(id,'work-observation-failed',{batchId:failedBatch.id,code:'INVALID_WORK_OBSERVATION_OUTPUT'});
  restoreWorkObservation(agent);assert.equal(workObservation.status(id).held,false);assert.equal(workObservation.sessionBlocked(id,'one'),true);
  assert.equal(workObservation.cursor(id,'one').afterSeq,-1);
  assert.equal(workObservation.cursor(id,'two').afterSeq,1);
  assert.deepEqual(workObservation.context(id).map(x=>x.sessionId),['two']);
  now+=workObservation.settings(id).intervalMs;badMode='ok';
  await execute(readTask());assert.equal(requests,2);
  workObservation.releaseRetry(id);
  await execute(readTask());assert.equal(requests,3);
  assert.equal(workObservation.read(id).status.heldSessions,0);
  assert.equal(workObservation.read(id).memories.items.filter(x=>x.valid).length,2);
  await execute(readTask());assert.equal(requests,3,'unchanged source consumes no extraction request');
  listed=['three'];
  const pending=readTask(),controller=new AbortController();
  await assert.rejects(()=>execute(pending,controller.signal,async messages=>{
    const response=await request(messages);controller.abort(new Error('preempted'));return response;
  }),/preempted/);
  assert.equal(workObservation.status(id).held,false);
  assert.equal(workObservation.read(id).memories.items.length,2);
  assert.equal(workObservation.cursor(id,'three').afterSeq,-1);
  await assert.rejects(()=>execute(readTask(),new AbortController().signal,async()=>{throw Error('AUTONOMOUS_BUDGET_EXHAUSTED');}),/AUTONOMOUS_BUDGET_EXHAUSTED/);
  assert.equal(workObservation.status(id).phase,'waiting-budget');assert.equal(workObservation.sessionBlocked(id,'three'),false);
  assert.equal(workObservation.status(id).nextCheckAt,now,'a newly granted budget may resume the same observation immediately');
  await autonomy.configure(id,{quotaEnabled:true,tokenQuotaEnabled:true,tokenLimit:1000000});
  const withoutEstimate=readTask(),beforeLanes=lanes.length;
  await runAutonomyTurn(agent,new AbortController().signal);
  const failed=autonomy.getTask(withoutEstimate.id);
  assert.equal(failed.status,'failed');assert.equal(failed.checkpoint.reason,'MODEL_BUDGET_ESTIMATE_UNAVAILABLE');
  assert.equal(workObservation.status(id).phase,'failed');assert.equal(workObservation.status(id).lastError,failed.checkpoint.reason);
  assert.equal(lanes.length,beforeLanes);assert.ok(workObservation.status(id).nextCheckAt>now);
  await autonomy.configure(id,{quotaEnabled:false});
  upstreamFailure='502 status code (no body)';
  const outage=readTask();await runAutonomyTurn(agent,new AbortController().signal);upstreamFailure=null;
  assert.equal(autonomy.getTask(outage.id).status,'failed');
  const retryAt=workObservation.fault(id,'three').retryAt;assert(retryAt>now);
  assert.equal(workObservation.read(id).status.heldSessions,0);
  assert.equal(workObservation.cursor(id,'three').afterSeq,-1);
  assert.equal(journal.value(id,'autonomyPaused',false),false);
  now=retryAt;assert.equal(workObservation.sessionBlocked(id,'three'),false);
  const resumed=offers().find(row=>row.behaviorId==='observe-work-sessions');assert.ok(resumed);
  const runOffer=row=>behaviors.execute(agent,{id:randomUUID(),checkpoint:{...row,plan:{input:row.behaviorInput}}},{signal:new AbortController().signal,valid(){},request});
  await runOffer(resumed);
  assert.equal(workObservation.cursor(id,'three').afterSeq,1);assert.equal(workObservation.fault(id,'three'),undefined);
  const priorRequests=requests;
  now+=workObservation.settings(id).intervalMs;await runOffer(offers().find(row=>row.behaviorId==='observe-work-sessions'));
  assert.equal(requests,priorRequests);assert.equal(workObservation.context(id).filter(row=>row.sessionId==='three').length,1);
  listed=['four'];bridge.readSessionIds.push('four');bridge.allowedSessionIds.push('four');
  await assert.rejects(()=>execute(readTask(),new AbortController().signal,async messages=>{
    const response=await request(messages);bridge.sessionReadEnabled=false;return response;
  }),/BEHAVIOR_UNAVAILABLE|CAPABILITY_POLICY_CHANGED/);
  assert.equal(workObservation.cursor(id,'four').afterSeq,-1);
  assert.equal(offers().length,0);assert.equal(workObservation.context(id).length,0);
  const syntheticCursor=journal.db.prepare('INSERT INTO human_work_observation_cursor VALUES(?,?,0,0,-1,NULL,NULL,?)');
  journal.transaction(()=>{for(let i=0;i<270;i++)syntheticCursor.run(id,'aux-'+i,now+i+1);});
  assert.ok(workObservation.trackedSessions(id,256,64).includes('two'),'visibility checks reach sources after the first 256');
  assert.equal(workObservation.reconcilePolicy(id).withdrawn,3,'revocation reaches older persisted evidence on a large host');
  bridge.sessionReadEnabled=true;
  assert.equal(workObservation.context(id).length,0,'restoring a grant cannot resurrect evidence from before revocation');
  workObservation.markVisible(id,['two']);
  const count=()=>journal.db.prepare("SELECT count(*) n FROM audit WHERE agent=? AND kind='work-observation-source-invalidated'").get(id).n;
  const before=count(),generation=workObservation.cursor(id,'two').generation;
  listed=[];missing=['two'];
  for(let i=0;i<3;i++)await execute(readTask());
  assert.equal(count(),before+1);assert.equal(workObservation.cursor(id,'two').generation,generation+1);
  listed=['two'];missing=[];await execute(readTask());
  listed=[];missing=['two'];await execute(readTask());
  assert.equal(count(),before+2);
  await verifySavedGrant();
  await verifyFollowups();
  console.log('Verified optional observation, per-session backoff, preemption, retained budget waits, terminal model configuration failures, saved DSH read revocation and restart reconciliation, and repeated source absence.');
}finally{journal.safety?.close();journal.close();await fs.rm(tmp,{recursive:true,force:true});}
