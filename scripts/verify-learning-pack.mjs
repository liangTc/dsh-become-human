import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');
registerHooks({resolve(name,context,next){try{return next(name,context);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}});
const {ControlJournal}=await import('../plugins/become-human/driver.mjs'),{DomainMemory}=await import('../plugins/become-human/domain.mjs'),{AutonomyStore}=await import('../plugins/become-human/autonomy-store.mjs'),{BehaviorRegistry}=await import('../plugins/become-human/behaviors.mjs'),{LearningPack}=await import('../plugins/become-human/learning-pack.mjs'),{apply}=await import('../plugins/become-human/behavior-packs/learning/index.mjs'),{candidate,selectionMemoryKey}=await import('../plugins/become-human/autonomy-opportunities.mjs'),{selectedTaskWorkflow}=await import('../plugins/become-human/autonomy-workflows.mjs'),{checkpointForOpportunity}=await import('../plugins/become-human/behavior-selection.mjs'),{prepareRuntimeProfile,workflowIds}=await import('../plugins/become-human-web/runtime-profile.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'human-learning-pack-')),cases=[],signal=new AbortController().signal;
async function test(name,fn){const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir);const j=new ControlJournal(path.join(dir,'test.sqlite'));j.ensure(id);const learningPack=new LearningPack(),domain=new DomainMemory(j,{learningPack}),autonomy=new AutonomyStore(j,domain),f={journal:j,domain,autonomy,learningPack,behaviors:new BehaviorRegistry(),tools:{catalog:()=>[]}},agent={id,factory:f,session:{snapshotEvents:()=>[]}};j.put(id,'autonomySettings',{enabled:true,learningEnabled:true,searchEnabled:true,proactiveEnabled:false,socialEnabled:false});const x={id,dir,j,f,agent};try{await fn(x);cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.stack});}finally{j.close();}console.log(JSON.stringify(cases.at(-1)));}
function install(x){let dispose;apply({humanLearning:{contractVersion:1},humanPlugins:{contractVersion:1,register:(_owner,d)=>({dispose:x.f.learningPack.register(d.learning)})},effect:fn=>{dispose=fn();}});return dispose;}
const settings=x=>x.f.autonomy.settings(x.id),next=x=>candidate(x.agent,signal,settings(x));
function task(x,kind='research',checkpoint={}){return x.f.autonomy.task(x.id,kind,{candidate:{kind,question:'核对材料'},memoryKey:selectionMemoryKey(x.agent,kind),plan:{decision:'execute',question:'核对材料',value:'核对范围',searchQuery:'scope'},...checkpoint},x.f.autonomy.persona(x.id,'selection').version);}
function context(x,t,extra={}){return {agent:x.agent,task:t,response:null,signal,epoch:1,turn:1,valid(){},phase(){},...extra};}
function storeNote(x,index){
  const excerpt='An observation about process '+index;
  return x.f.autonomy.commitNote(x.id,task(x,'learn-ai'),{url:'https://example.org/process/'+index,digest:'a'.repeat(64),excerpt,partial:true},{
    title:'Process '+index,summary:excerpt,claims:[{text:excerpt,quote:excerpt}],relevance:excerpt,question:'What remains uncertain?',share:excerpt,
  });
}
await test('Removing the pack excludes linked memories before ranking and from ordinary management reads',async x=>{
  const dispose=install(x),{domain,autonomy}=x.f,{id,j}=x;
  const {HumanManagement}=await import('../plugins/become-human/management.mjs');
  const management=new HumanManagement(x.f),source=randomUUID();
  domain.source(id,{id:source,kind:'user',body:'周末准备去散步。'});
  const episode=domain.save(id,{type:'episode',truth:'factual',refs:[source],payload:{userSaid:'周末准备去散步。'}});
  const customSkill=domain.save(id,{type:'skill',truth:'inferred',refs:[source],payload:{summary:'一个独立的技能记录'}});
  const noteIds=Array.from({length:10},(_,i)=>storeNote(x,i)),sample=autonomy.note(id,noteIds[0]);
  assert.equal(management.read(id,{kind:'notes',limit:2}).items.length,2);
  assert.equal(autonomy.snapshot(id).notes.length,10);
  dispose();
  assert.deepEqual(autonomy.snapshot(id).notes,[]);
  assert.deepEqual(new Set(domain.context(id).memories.map(m=>m.id)),new Set([episode,customSkill]));
  assert.deepEqual(new Set(domain.list(id).map(m=>m.id)),new Set([episode,customSkill]));
  assert.equal(management.read(id,{kind:'memories'}).total,2);
  assert.throws(()=>management.read(id,{kind:'memory-history',memoryId:sample.memory_id}),/MEMORY_NOT_FOUND/);
  for(const kind of ['notes','note-history','action-notes'])assert.throws(()=>management.read(id,{kind,noteId:sample.id}),/LEARNING_PACK_UNAVAILABLE/);
  await assert.rejects(()=>management.mutate(id,{op:'note-revise',noteId:sample.id,summary:'new',expectedVersion:0}),/LEARNING_PACK_UNAVAILABLE/);
  assert.throws(()=>autonomy.feedback(id,sample.id,'not-now'),/LEARNING_PACK_UNAVAILABLE/);
  assert.equal(management.allPages(id,'notes').length,10);
  assert.equal(management.allPages(id,'memoryList').length,12);
  assert.equal(j.db.prepare('SELECT count(*) AS n FROM learning_note WHERE agent=?').get(id).n,10);
  install(x);
  assert.equal(management.read(id,{kind:'notes'}).total,10);
});
await test('Detaching the pack stops new report proposals, pending goals and pending writes while keeping completed files readable',async x=>{
  const dispose=install(x),{id,j}=x,{domain,autonomy}=x.f,noteId=storeNote(x,1);
  const {GoalEngine}=await import('../plugins/become-human/goals.mjs'),{ActionStore}=await import('../plugins/become-human/actions.mjs');
  const goals=new GoalEngine(j,domain,autonomy),actions=new ActionStore(j,domain,{root:path.join(x.dir,'artifacts'),validNote:(agent,id)=>goals.validNote(agent,id),requireSignedApproval:false});
  goals.setActions(actions);
  const propose=()=>actions.proposeReport(id,{requestId:randomUUID(),title:'整理已存材料',noteIds:[noteId]});
  const approve=a=>actions.approve(id,a.id,{expectedVersion:a.version,digest:a.digest});
  const complete=approve(propose());await actions.execute(id,complete.id,{valid:()=>true});
  const approved=approve(propose()),draft=propose(),ownerSource=randomUUID();domain.source(id,{id:ownerSource,kind:'user',body:'请整理这个报告。'});
  const goal=goals.propose(id,{description:'整理可用材料',refs:[ownerSource],expires:Date.now()+86400000,milestones:[{kind:'write-report',question:'整理现有材料',noteIds:[noteId]}]});
  goals.transition(id,goal.id,'activate',{expectedVersion:goal.version});
  assert.equal(goals.candidate(id)?.kind,'write-report');
  dispose();
  assert.equal(goals.candidate(id),null);
  assert.equal(actions.next(id),null);
  assert.throws(propose,/LEARNING_PACK_UNAVAILABLE/);
  assert.throws(()=>approve(draft),/LEARNING_PACK_UNAVAILABLE/);
  assert.equal(actions.get(id,approved.id).status,'approved');
  assert.equal((await actions.readContent(id,complete.id)).digest,complete.digest);
  assert.equal(actions.list(id).length,3);
  install(x);
  assert.equal(actions.next(id)?.id,approved.id);
  assert.equal(goals.candidate(id)?.goal.id,goal.id);
});
await test('A persisted report task holds on removal and can run with the package installed and autonomous study disabled',async x=>{
  const dispose=install(x),t=task(x,'write-report');dispose();
  assert.equal(await next(x),null);
  assert.equal(x.f.autonomy.getTask(t.id).checkpoint.learningHold,'LEARNING_PACK_UNAVAILABLE');
  install(x);x.j.put(x.id,'autonomySettings',{...settings(x),learningEnabled:false});
  assert.equal((await next(x)).task.id,t.id);
});
await test('Missing pack ignores previously enabled learning preferences',async x=>{assert.equal(await next(x),null);assert.deepEqual(x.f.learningPack.catalog(),[]);assert.throws(()=>selectedTaskWorkflow('research',x.agent),/LEARNING_PACK_UNAVAILABLE/);});
await test('Explicit install offers learning without any source or model I/O',async x=>{install(x);assert((await next(x)).opportunities.some(r=>r.kind==='research'));assert.equal(x.f.learningPack.catalog().length,1);});
await test('Learning switch off suppresses even an installed pack',async x=>{install(x);x.j.put(x.id,'autonomySettings',{...settings(x),learningEnabled:false});assert.equal(await next(x),null);});
await test('Pack removal preserves pending plan and restores same old checkpoint on reinstall',async x=>{const dispose=install(x),t=task(x);dispose();assert.equal(await next(x),null);const held=x.f.autonomy.getTask(t.id);assert.equal(held.status,'suspended');assert.deepEqual(held.checkpoint.plan,t.checkpoint.plan);assert.equal(held.checkpoint.learningHold,'LEARNING_PACK_UNAVAILABLE');install(x);assert.equal((await next(x)).task.id,t.id);assert.equal(x.f.autonomy.getTask(t.id).checkpoint.learningHold,undefined);});
await test('Settings disable holds pending learning instead of cancelling it',async x=>{install(x);const t=task(x);x.j.put(x.id,'autonomySettings',{...settings(x),learningEnabled:false});await next(x);assert.equal(x.f.autonomy.getTask(t.id).status,'suspended');assert.equal(x.f.autonomy.getTask(t.id).checkpoint.learningHold,'LEARNING_DISABLED');});
await test('Unknown checkpoint contract stays held',async x=>{install(x);const t=task(x,'research',{learningPackVersion:99});await next(x);assert.equal(x.f.autonomy.getTask(t.id).checkpoint.learningHold,'LEARNING_PACK_CHANGED');});
await test('Held learning cannot starve a non-learning task',async x=>{x.f.behaviors.register('noop',{version:1,title:'检查',description:'检查现状',inputSchema:{type:'object',properties:{},additionalProperties:false},execute:async()=>({status:'completed',summary:'完成'})});task(x);const d=x.f.behaviors.definition(x.agent,'noop'),t=task(x,'behavior',{behaviorId:d.id,behaviorFingerprint:d.fingerprint,plan:{input:{}}});assert.equal((await next(x)).task.id,t.id);});
await test('Goal and board research opportunities cannot bypass a missing pack',async x=>{x.f.goals={candidate:()=>({kind:'research',question:'目标研究',goal:{id:'goal'}})};assert.equal(await next(x),null);});
await test('Disabled pack never scans or pushes the note sharing backlog',async x=>{x.f.autonomy.shareCandidates=()=>{throw Error('MUST_NOT_SCAN');};x.j.put(x.id,'autonomySettings',{...settings(x),proactiveEnabled:true,quietStart:0,quietEnd:0});x.j.put(x.id,'autonomyActivatedAt',0);const result=await next(x);assert(result?.opportunities.every(r=>r.kind!=='share-insight'));});
await test('Existing share task holds but old note records are not modified',async x=>{const t=task(x,'share-insight',{noteId:'old-note'}),before=x.f.autonomy.notes(x.id);await next(x);assert.equal(x.f.autonomy.getTask(t.id).status,'suspended');assert.deepEqual(x.f.autonomy.notes(x.id),before);});
await test('Legacy discovery suspension does not invoke a model',async x=>{install(x);const t=task(x),ctx=context(x,t,{discoverSource:async()=>null,executeModel:async()=>{throw Error('MUST_NOT_CALL');}});await selectedTaskWorkflow(t.kind,x.agent).execute(ctx);assert.equal(ctx.task.id,t.id);assert.equal(ctx.response,null);});
await test('Preemption during execution cannot publish a returned draft',async x=>{const dispose=install(x),t=task(x,'learn-ai',{source:{url:'https://example.org',digest:'a'.repeat(64)}}),ctx=context(x,t,{executeModel:async()=>{dispose();return {rid:'model-attempt',text:'[WAIT]'};}});await assert.rejects(()=>selectedTaskWorkflow(t.kind,x.agent).execute(ctx),/LEARNING_PACK_UNAVAILABLE/);assert.equal(ctx.response.rid,'model-attempt');assert.equal(x.f.autonomy.notes(x.id).length,0);});
await test('Insufficient selected source does not publish a note or notification',async x=>{install(x);const t=task(x,'learn-ai',{source:{url:'https://example.org',digest:'a'.repeat(64)}});let rejected=0;const ctx=context(x,t,{executeModel:async()=>({text:'[WAIT]'}),rejectInsufficientEvidence:()=>rejected++});assert.equal(await selectedTaskWorkflow(t.kind,x.agent).prepare(ctx),true);await selectedTaskWorkflow(t.kind,x.agent).execute(ctx);assert.equal(rejected,1);assert.equal(ctx.response,null);assert.equal(x.f.autonomy.notes(x.id).length,0);});
await test('Validated result saves through core storage without automatic sharing',async x=>{install(x);const source={url:'https://example.org/process',title:'Processing',digest:'a'.repeat(64),excerpt:'The material is heated to limit oxidation.',partial:false};const t=task(x,'learn-ai',{source});const draft={evidenceStatus:'sufficient',title:'Processing',summary:source.excerpt,claims:[{text:source.excerpt,evidenceIds:['E1']}],relevance:'Processing.',question:'What remains uncertain?',share:'I am reading about processing.'};const ctx=context(x,t,{executeModel:async()=>({rid:randomUUID(),text:JSON.stringify(draft)})});await selectedTaskWorkflow(t.kind,x.agent).execute(ctx);assert.equal(x.f.autonomy.notes(x.id).length,1);assert.equal(x.f.autonomy.getTask(t.id).status,'completed');assert.equal(x.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(x.id).n,0);const stop=x.f.learningPack.provider;x.f.learningPack.provider=null;assert.equal(x.f.autonomy.notes(x.id).length,1);x.f.learningPack.provider=stop;});
await test('Model errors retain old failures; reinstall does not retry them',async x=>{const dispose=install(x),t=task(x);x.f.autonomy.update(t.id,'failed',{...t.checkpoint,reason:'MODEL_EXECUTION_FAILED'});dispose();install(x);const result=await next(x);assert(!result?.task||result.task.id!==t.id);assert.equal(x.f.autonomy.getTask(t.id).status,'failed');});
await test('Duplicate provider and unsupported version fail closed',x=>{install(x);assert.throws(()=>install(x),/INVALID_LEARNING_PACK/);const pack=new LearningPack();assert.throws(()=>pack.register({version:2,collect(){},prepare(){},execute(){}}),/INVALID_LEARNING_PACK/);});
await test('New checkpoints retain the learning contract version',()=>assert.equal(checkpointForOpportunity({kind:'research',question:'check'}).learningPackVersion,1));
await test('Evidence rejection retains the next source and records exhausted attempts in the original task',async x=>{
 install(x);
 const source={url:'https://example.org/source',digest:'a'.repeat(64)};
 for(const reads of [1,2]){
   const t=task(x,'research',{source,discovery:{results:[{},{}]},researchReads:reads});
   const rid=randomUUID();x.j.beginAttempt(x.id,rid,1,1,{taskId:t.id,lane:'autonomy'});
   const ctx=context(x,t,{executeModel:async()=>({rid,text:'[WAIT]'})});
   await selectedTaskWorkflow(t.kind,x.agent).execute(ctx);
   const stored=x.f.autonomy.getTask(t.id);
   assert.equal(x.j.db.prepare('SELECT state FROM attempt WHERE id=?').get(rid).state,'evidence-insufficient');
   if(reads===1){
     assert.equal(stored.status,'suspended');assert.equal(stored.checkpoint.source,null);
     assert.equal(stored.checkpoint.rejectedSources[0].digest,source.digest);
   }else{
     assert.equal(stored.status,'failed');assert.equal(stored.checkpoint.reason,'INSUFFICIENT_SOURCE_EVIDENCE');
   }
 }
 assert.equal(x.f.autonomy.notes(x.id).length,0);
 assert.equal(x.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(x.id).n,0);
});
await test('An older cooling checkpoint cannot hide a ready report, including behind a full page',async x=>{
 install(x);x.j.put(x.id,'autonomySettings',{...settings(x),learningEnabled:false});
 const store=x.f.autonomy,now=Date.now();
 const reports=Array.from({length:34},(_,i)=>{
   const t=task(x,'write-report',{candidate:{kind:'write-report',question:'报告 '+i}});
   x.j.db.prepare('UPDATE autonomy_task SET created=? WHERE id=?').run(now+i,t.id);
   if(i!==33)store.defer(x.id,t,'cooling',60000,now);
   return t;
 });
 assert.equal(await candidate(x.agent,signal,settings(x),now),null);
 assert.equal((await candidate(x.agent,signal,settings(x),now)).task.id,reports[33].id);
 assert.equal((await candidate(x.agent,signal,settings(x),now+60001)).task.id,reports[0].id);
});
await test('Custom behavior can wait for its own condition without blocking a later checkpoint',async x=>{
 install(x);x.j.put(x.id,'autonomySettings',{...settings(x),learningEnabled:false});
 let ready=false,checked=0;
 x.f.behaviors.register('local-wait',{version:1,title:'测试',description:'等待条件',inputSchema:{type:'object',properties:{},additionalProperties:false},
   readyToResume(agent,ctx){assert.equal(agent.id,x.id);assert.deepEqual(ctx.input,{});assert.equal(ctx.result.summary,'等待');checked++;return ready;},
   execute:async()=>({status:'completed',summary:'完成'})});
 const def=x.f.behaviors.definition(x.agent,'local-wait'),t=task(x,'behavior',{behaviorId:def.id,behaviorFingerprint:def.fingerprint,plan:{input:{}},behaviorResult:{status:'waiting',summary:'等待'}});
 const report=task(x,'write-report');x.j.db.prepare('UPDATE autonomy_task SET created=created-60000 WHERE id=?').run(t.id);
 assert.equal((await next(x)).task.id,report.id);assert.equal(checked,1);
 ready=true;assert.equal((await next(x)).task.id,t.id);assert.equal(checked,2);
});
await test('Malformed provider readiness only holds that task and does not flood the journal',async x=>{
 x.f.behaviors.register('bad-ready',{version:1,title:'测试',description:'错误条件',inputSchema:{type:'object',properties:{},additionalProperties:false},
   readyToResume:async()=>true,execute:async()=>({status:'completed',summary:'完成'})});
 const def=x.f.behaviors.definition(x.agent,'bad-ready'),t=task(x,'behavior',{behaviorId:def.id,behaviorFingerprint:def.fingerprint,plan:{input:{}},behaviorResult:{status:'waiting',summary:'等待'}});
 for(let i=0;i<2;i++)assert.equal(await next(x),null);
 const events=x.j.db.prepare("SELECT data FROM audit WHERE agent=? AND kind='behavior-provider-held'").all(x.id);
 assert.equal(events.length,1);assert.equal(JSON.parse(events[0].data).taskId,t.id);
 assert.equal(x.f.autonomy.getTask(t.id).status,'ready');
});
await test('Workflow ownership is verified separately from builtin replacement',async x=>{assert.throws(()=>workflowIds({dsh:{human:{providesWorkflows:['chat']}}}),/INVALID_RUNTIME_WORKFLOW/);const pkg=path.join(x.dir,'node_modules','dsh-human-learning');await fs.mkdir(pkg,{recursive:true});await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({dsh:{human:{providesWorkflows:['deep-learning']}}}));await fs.writeFile(path.join(x.dir,'package.json'),JSON.stringify({dsh:{profile:{bundles:['dsh-human-learning']}}}));const result=await prepareRuntimeProfile(x.dir,[{id:'become-human',config:{}}]);assert.equal(result.behaviorOwners['deep-learning'],'dsh-human-learning');const text=await fs.readFile(path.join(x.dir,'cordis.patch.yml'),'utf8');assert(text.includes('externalBehaviorIds: []'));});
await test('Broken optional collector cannot stop another registered behavior',async x=>{x.f.learningPack.register({version:1,collect:()=>[{kind:'unknown'}],prepare(){},execute(){}});x.f.behaviors.register('check',{version:1,title:'检查',description:'查看现状',inputSchema:{type:'object',properties:{},additionalProperties:false},opportunities:()=>[{question:'查看现状'}],execute:async()=>({status:'completed',summary:'完成'})});const result=await next(x);assert(result.opportunities.some(row=>row.behaviorId==='check'));assert(!result.opportunities.some(row=>row.kind==='unknown'));assert.equal(x.j.value(x.id,'autonomyPaused',false),false);});
await test('Learning workflows never pollute the generic goal behavior catalog',async x=>{install(x);const {HumanManagement}=await import('../plugins/become-human/management.mjs');x.f.goals={behaviorContext:()=>{}};const scope={factory:x.f,journal:x.j};const behaviors=HumanManagement.prototype.read.call(scope,x.id,{kind:'behavior-catalog'}),workflows=HumanManagement.prototype.read.call(scope,x.id,{kind:'workflow-catalog'});assert(!behaviors.some(r=>r.id==='deep-learning'));assert.deepEqual(workflows.map(r=>r.id),['deep-learning']);});
const result={at:new Date().toISOString(),passed:cases.filter(r=>r.passed).length,failed:cases.filter(r=>!r.passed).length,cases,scope:'Isolated SQLite, mock models, temporary profiles; no production or IM operations.'};if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed}));if(result.failed)process.exitCode=1;
