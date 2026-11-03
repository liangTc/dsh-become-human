import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');
const hook=registerHooks({resolve(name,context,next){try{return next(name,context);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw error;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}});
const {ControlJournal}=await import('../plugins/become-human/driver.mjs'),{DomainMemory}=await import('../plugins/become-human/domain.mjs'),{AutonomyStore}=await import('../plugins/become-human/autonomy-store.mjs'),{GoalEngine}=await import('../plugins/become-human/goals.mjs'),{ToolExecutor}=await import('../plugins/become-human/tool-executor.mjs'),{BehaviorRegistry,syncCapabilityBehaviors}=await import('../plugins/become-human/behaviors.mjs'),{ExperienceStore,registerExperienceBehavior}=await import('../plugins/become-human/experience.mjs'),{PersonaDevelopment}=await import('../plugins/become-human/persona-development.mjs'),{candidate}=await import('../plugins/become-human/autonomy.mjs'),{choiceOpportunity,checkpointForOpportunity,resolveBehaviorChoice}=await import('../plugins/become-human/behavior-selection.mjs');
const {LearningPack}=await import('../plugins/become-human/learning-pack.mjs'),{apply:installLearningPack}=await import('../plugins/become-human/behavior-packs/learning/index.mjs');
function learning(f){f.f.learningPack=new LearningPack();installLearningPack({humanLearning:{contractVersion:1,register:d=>f.f.learningPack.register(d)},effect:fn=>fn()});f.j.put(f.id,'autonomySettings',{...f.f.autonomy.settings(f.id),learningEnabled:true});}
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'human-behavior-')),cases=[];
const schema={type:'object',properties:{value:{type:'string',minLength:1,maxLength:80}},required:['value'],additionalProperties:false};
async function fixture(){const id=randomUUID(),dir=path.join(root,id);await fs.mkdir(dir);const journal=new ControlJournal(path.join(dir,'test.sqlite'));journal.ensure(id);const domain=new DomainMemory(journal),autonomy=new AutonomyStore(journal,domain),tools=new ToolExecutor(journal),behaviors=new BehaviorRegistry(),experience=new ExperienceStore(journal,domain,{tools}),goals=new GoalEngine(journal,domain,autonomy),f={journal,domain,autonomy,tools,behaviors,experience,goals};domain.experience=experience;goals.setBehaviors(behaviors,()=>agent);const agent={id,factory:f,session:{snapshotEvents:()=>[]},desired:()=>({desired:'running',epoch:1})};journal.put(id,'autonomySettings',{enabled:true,learningEnabled:false,searchEnabled:false,proactiveEnabled:false,socialEnabled:false});const register=()=>behaviors.register('make-index',{version:1,title:'整理索引',description:'在已授权范围内整理测试索引',inputSchema:schema,opportunities:()=>[{question:'整理当前资料索引'}],execute:async(a,input)=>({status:'completed',summary:'索引已整理：'+input.value})});return {id,dir,agent,f,j:journal,register,close:()=>journal.close()};}
async function test(name,body){let f;try{f=await fixture();await body(f);cases.push({name,passed:true});}catch(error){cases.push({name,passed:false,error:error.stack});}finally{f?.close();}console.log(JSON.stringify(cases.at(-1)));}
function taskFor(f,next,plan){const task=f.f.autonomy.task(f.id,next.kind,{...checkpointForOpportunity(next),plan},f.f.domain.persona(f.id).version);return task;}
const context={signal:new AbortController().signal,valid(){}};

await test('Learning disabled still offers a registered non-learning behavior',async f=>{f.register();const next=await candidate(f.agent,context.signal,f.f.autonomy.settings(f.id));assert.equal(next.kind,'behavior-choice');assert(next.opportunities.some(x=>x.behaviorId==='make-index'));assert(!next.opportunities.some(x=>['research','learn-ai'].includes(x.kind)));});
await test('Selection diagnostics distinguish malformed shape and unknown IDs without retaining model content',f=>{f.register();const task=taskFor(f,choiceOpportunity(f.f.behaviors.opportunities(f.agent,{})));for(const [value,reason] of [[null,'object-required'],[{secretField:'private-content'},'unexpected-top-level-fields'],[{opportunityId:'private-content',plan:{}},'execute-plan-required'],[{opportunityId:'private-content',plan:{decision:'execute'}},'unknown-opportunity']])assert.throws(()=>resolveBehaviorChoice(f.agent,task,value),e=>e.message==='INVALID_BEHAVIOR_SELECTION'&&e.validationDiagnostic.reason===reason&&!JSON.stringify(e.validationDiagnostic).includes('private-content'));});
await test('Candidates do not fetch configured sources before selection',async f=>{learning(f);const settings={...f.f.autonomy.settings(f.id),learningEnabled:true,sources:[{url:'https://127.0.0.1:1/unreachable',title:'Public material',topic:'Read current information'}]};const next=await candidate(f.agent,context.signal,settings);assert(next.opportunities.some(x=>x.kind==='learn-ai'&&x.sourceSpec&&!x.source));});
await test('Model can choose different opportunities; unknown IDs and input schemas are rejected',f=>{f.register();const next=choiceOpportunity(f.f.behaviors.opportunities(f.agent,{})),task=taskFor(f,next);const chosen=next.opportunities[0],plan={decision:'execute',question:chosen.question,value:'实际用途',input:{value:'索引'}};assert.equal(resolveBehaviorChoice(f.agent,task,{opportunityId:chosen.opportunityId,plan}).selected.behaviorId,'make-index');assert.equal(resolveBehaviorChoice(f.agent,task,{decision:'wait',reason:'当前没有必要'}).selected,null);assert.throws(()=>resolveBehaviorChoice(f.agent,task,{opportunityId:'invented',plan}),/INVALID_BEHAVIOR_SELECTION/);assert.throws(()=>resolveBehaviorChoice(f.agent,task,{opportunityId:chosen.opportunityId,plan:{...plan,input:{unexpected:1}}}),/INVALID_TOOL_INPUT/);});
await test('Provider removal during execution rejects a stale completion',async f=>{let dispose;dispose=f.f.behaviors.register('transient',{version:1,title:'临时行为',description:'取消校验',inputSchema:schema,execute:async()=>{dispose();return {status:'completed',summary:'不能提交'};}});const definition=f.f.behaviors.definition(f.agent,'transient'),task=taskFor(f,{kind:'behavior',question:'检查',behaviorId:'transient',behaviorFingerprint:definition.fingerprint},{input:{value:'x'}});await assert.rejects(()=>f.f.behaviors.execute(f.agent,task,context),/BEHAVIOR_DEFINITION_CHANGED/);});
await test('A non-learning goal advances using a behavior receipt, retains owner outcome review',async f=>{f.register();const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'请整理当前资料的索引。'});let g=f.f.goals.propose(f.id,{description:'整理索引',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'资料'},question:'整理当前资料索引'}]});g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});const next=f.f.goals.candidate(f.id),task=taskFor(f,next,{decision:'execute',question:next.question,value:'减少查找时间',input:next.behaviorInput});f.f.goals.attachTask(f.id,next.goal,task.id);const result=await f.f.behaviors.execute(f.agent,task,context);f.f.autonomy.update(task.id,'completed',{...task.checkpoint,behaviorResult:result});f.f.goals.reconcile(f.id,g.id);g=f.f.goals.get(f.id,g.id);assert.equal(g.steps[0].status,'completed');assert.equal(g.status,'awaiting-review');assert.equal(g.evaluation.noteCount,0);assert(g.steps[0].behaviorReceipt);});
await test('Execution evidence and reflection survive restart; withdrawn sources stop growth',async f=>{f.register();const definition=f.f.behaviors.definition(f.agent,'make-index'),task=taskFor(f,{kind:'behavior',behaviorId:'make-index',behaviorFingerprint:definition.fingerprint,question:'整理资料'},{input:{value:'目录'},question:'整理资料',value:'提高查找效率'});const result=await f.f.behaviors.execute(f.agent,task,context);f.f.autonomy.update(task.id,'completed',{...task.checkpoint,behaviorResult:result});const e=f.f.experience.recordTask(f.id,task.id);assert(e.source);assert.equal(f.f.experience.recordTask(f.id,task.id).id,e.id);let now=Date.now();const store=new ExperienceStore(f.j,f.f.domain,{clock:()=>now,tools:f.f.tools});const r=store.reflect(f.id,{requestId:'review-one',experienceIds:[e.id],lesson:'索引有助于查找',nextApproach:'下次先确认目录结构',role:{label:'项目整理者',purpose:'阶段性维护索引',expiresAt:now+10000}});assert.equal(store.context(f.id).phaseRole.label,'项目整理者');now+=20000;assert.equal(store.context(f.id).phaseRole,null);const development=new PersonaDevelopment(f.j,f.f.domain);assert.equal(development.sourceEvidence(f.id,e.source).kind,'digital-experience');f.j.db.prepare("UPDATE source_record SET status='deleted' WHERE id=?").run(e.source);assert.equal(store.context(f.id).strategyHints.length,0);assert.equal(development.sourceEvidence(f.id,e.source),null);assert(r.id);});
await test('Development tasks never become real personality evidence',f=>{const task=taskFor(f,{kind:'chat',question:'【开发测试】这只是合成测试'}, {question:'【开发测试】这只是合成测试',value:'验证'});f.f.autonomy.update(task.id,'completed');const e=f.f.experience.recordTask(f.id,task.id);assert.equal(e.source,null);assert.equal(f.f.experience.recent(f.id).length,0);});
await test('Events arriving during an action are not acknowledged by its completion',f=>{f.f.autonomy.event(f.id,'before','timer',{});const seen=f.f.autonomy.events(f.id).map(e=>e.id);f.f.autonomy.event(f.id,'during','input',{});f.f.autonomy.completeEvents(f.id,seen);assert.equal(f.f.autonomy.events(f.id).length,1);assert.equal(f.f.autonomy.events(f.id)[0].kind,'input');});
await test('Unapproved custom tools are absent; explicitly autonomous reads execute once',async f=>{let calls=0;const register=(name,autonomous)=>f.f.tools.register(name,{description:'读取测试索引。'.repeat(200),inputSchema:schema,effect:'read',autonomous,execute:async()=>{calls++;return {entries:2,excerpt:"x".repeat(32000)};}});register('private-read',false);register('approved-read',true);syncCapabilityBehaviors(f.f,f.id);assert.equal(f.f.behaviors.definition(f.agent,'tool.private-read'),null);const definition=f.f.behaviors.definition(f.agent,'tool.approved-read'),task=taskFor(f,{kind:'behavior',behaviorId:definition.id,behaviorFingerprint:definition.fingerprint,question:'读取索引'},{input:{value:'index'}});const first=await f.f.behaviors.execute(f.agent,task,context),second=await f.f.behaviors.execute(f.agent,task,context);assert.equal(first.status,'completed');assert.equal(first.jobId,second.jobId);assert.equal(calls,1);assert.equal(first.preview.text.length,1200);assert.equal(first.preview.truncated,true);assert.equal(first.result,undefined);f.f.autonomy.update(task.id,'completed',{...task.checkpoint,behaviorResult:first});f.f.experience.recordTask(f.id,task.id);assert.equal(f.f.experience.context(f.id).experiences[0].behaviorResult.preview.evidenceStatus,'tool-returned-unverified');});
await test('Experience reflection behavior registers without a scheduler change',f=>{registerExperienceBehavior(f.f);assert(f.f.behaviors.definition(f.agent,'reflect-experience'));});

await test('Whole autonomous turn selects and executes a non-learning behavior with one model call',async f=>{
  const {SafetyLedger}=await import('../plugins/become-human/safety.mjs'),{runAutonomyTurn}=await import('../plugins/become-human/autonomy.mjs');
  f.j.safety=await SafetyLedger.open(path.join(f.dir,'safety'));
  try{
    await f.f.autonomy.configure(f.id,{enabled:true,learningEnabled:false,searchEnabled:false,socialEnabled:false,proactiveEnabled:false,quotaEnabled:false});
    const {ReminderStore}=await import('../plugins/become-human/reminders.mjs');f.f.reminders=new ReminderStore(f.j);
    f.register();f.j.set(f.id,'running');f.j.put(f.id,'remaining',null);const events=[];let calls=0;
    f.agent.session={id:f.id,snapshotEvents:()=>events,append(type,data){events.push({type,data,time:Date.now()});}};
    f.agent.inbox={nextStep:[],nextTurn:[]};f.agent.flush=async()=>{};f.agent.desired=()=>f.j.get(f.id);
    f.f.config={provider:'synthetic',model:'synthetic',domainEnabled:true};f.f.tickets=new WeakMap();f.f.allowCall=async()=>{};
    f.agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall:async()=>({config:{provider:'synthetic',model:'synthetic'},context:{maxTokens:65536},stream:async function*(input){calls++;const content=input.messages.flatMap(m=>m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'),match=content.match(/"opportunityId":"([a-f0-9]{24})","kind":"behavior","direction":"整理当前资料索引"/u);assert(match,'non-learning opportunity in actual model input');yield {type:'text-delta',text:JSON.stringify({opportunityId:match[1],plan:{decision:'execute',question:'整理当前资料索引',value:'减少查找时间',input:{value:'目录'}}})};yield {type:'usage',usage:{inputTokens:100,outputTokens:30}};yield {type:'finish',reason:{kind:'stop'}};}})}};
    await runAutonomyTurn(f.agent,new AbortController().signal);
    const row=f.j.db.prepare("SELECT * FROM autonomy_task WHERE agent=? AND kind='behavior'").get(f.id);
    const diagnostics=f.j.db.prepare('SELECT kind,data FROM audit WHERE agent=? ORDER BY seq DESC LIMIT 8').all(f.id);
    assert(row,JSON.stringify(diagnostics));assert.equal(row.status,'completed',JSON.stringify(diagnostics));assert.equal(calls,1);assert.equal(f.f.experience.recent(f.id).length,1);assert.equal(f.j.value(f.id,'autonomyPaused',false),false);
  }finally{f.j.safety.close();}
});

await test('Paused behavior goal retains its job and cannot bypass the task execution lane',async f=>{
  let writes=0;f.f.tools.register('approved-write',{description:'Prepare a synthetic write',inputSchema:schema,effect:'write',autonomous:true,prepare:()=>({scope:'isolated-test'}),execute:async()=>{writes++;return {written:true};}});
  syncCapabilityBehaviors(f.f,f.id);const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'请执行这个受管操作。'});
  let g=f.f.goals.propose(f.id,{description:'受管操作',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'tool.approved-write',input:{value:'item'},question:'执行受管操作'}]});
  g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});const next=f.f.goals.candidate(f.id),task=taskFor(f,next,{decision:'execute',question:next.question,value:'完成操作',input:next.behaviorInput});f.f.goals.attachTask(f.id,next.goal,task.id);
  const result=await f.f.behaviors.execute(f.agent,task,context);assert.equal(result.status,'waiting');f.f.autonomy.update(task.id,'suspended',{...task.checkpoint,behaviorResult:result});
  g=f.f.goals.get(f.id,g.id);g=f.f.goals.transition(f.id,g.id,'pause',{expectedVersion:g.version});assert.equal(f.f.goals.taskAllowed(f.id,task),false);
  // Simulates only a queued job. No approval is forged or used to dispatch it.
  const job=f.f.tools.get(f.id,result.jobId);f.f.tools.update(job,'queued');assert.equal(f.f.tools.next(f.id),null);
  await assert.rejects(()=>f.f.tools.execute(f.id,job.id,context),/CAPABILITY_TASK_CONTEXT_REQUIRED/);assert.equal(writes,0);
  assert.equal(f.f.autonomy.pending(f.id),undefined);g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});assert.equal(f.f.goals.taskAllowed(f.id,task),true);assert.equal(f.f.autonomy.pending(f.id).id,task.id);assert.equal(f.f.tools.get(f.id,job.id).id,result.jobId);
});
await test('Generic goal revision keeps behavior inputs and preserves prior steps',f=>{
  f.register();const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'请整理资料。'});let g=f.f.goals.propose(f.id,{description:'整理资料',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'first'},question:'初步整理'}]});
  g=f.f.goals.revise(f.id,g.id,{expectedVersion:g.version,appendMilestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'second'},question:'进一步整理'}]});assert.equal(g.steps.length,2);assert.equal(g.status,'paused');assert.equal(g.steps[1].input.value,'second');
});
await test('Experience and reversible strategy persist through closing and reopening SQLite',async f=>{
  f.register();const d=f.f.behaviors.definition(f.agent,'make-index'),t=taskFor(f,{kind:'behavior',question:'整理目录',behaviorId:d.id,behaviorFingerprint:d.fingerprint},{input:{value:'目录'}});f.f.autonomy.update(t.id,'completed',{...t.checkpoint,behaviorResult:await f.f.behaviors.execute(f.agent,t,context)});
  const e=f.f.experience.recordTask(f.id,t.id),r=f.f.experience.reflect(f.id,{requestId:'durable-review',experienceIds:[e.id],lesson:'目录可以帮助定位内容',nextApproach:'下次先查看已有目录'});f.j.close();
  const journal=new ControlJournal(path.join(f.dir,'test.sqlite'));f.close=()=>journal.close();const domain=new DomainMemory(journal),store=new ExperienceStore(journal,domain);
  assert.equal(store.context(f.id).experiences[0].id,e.id);assert.equal(store.context(f.id).strategyHints[0].id,r.id);store.withdraw(f.id,r.id);assert.equal(store.context(f.id).strategyHints.length,0);
});
await test('Reflection about reflection cannot generate new independent personality evidence',f=>{
  const t=taskFor(f,{kind:'behavior',question:'回顾最近经历',behaviorId:'reflect-experience'},{question:'回顾最近经历',value:'改进方法',input:{}});f.f.autonomy.update(t.id,'completed',{...t.checkpoint,behaviorResult:{status:'completed',summary:'形成暂定认识'}});
  const e=f.f.experience.recordTask(f.id,t.id);assert.equal(e.source,null);assert.equal(e.data.development,false);assert.equal(e.data.growthEligible,false);assert.equal(f.f.experience.recent(f.id).length,0);
});
await test('Faulty availability provider does not block other behavior opportunities',f=>{
  f.f.behaviors.register('broken',{version:1,title:'不可用',description:'故障隔离',inputSchema:schema,available(){throw Error('UNAVAILABLE');},opportunities:()=>[],execute:async()=>({status:'failed',summary:'不可用'})});f.register();assert(f.f.behaviors.opportunities(f.agent,{}).some(row=>row.behaviorId==='make-index'));assert(f.f.tools.catalog().length);
});
await test('Pending events survive the historical event pruning threshold',f=>{for(let n=0;n<280;n++)f.f.autonomy.event(f.id,'pending-'+n,'timer',{n});assert.equal(f.j.db.prepare("SELECT count(*) n FROM autonomy_event WHERE agent=? AND status='pending'").get(f.id).n,280);});
await test('Object key ordering does not change a fixed behavior input',f=>{
  f.f.behaviors.register('two-fields',{version:1,title:'字段检查',description:'对象参数顺序',inputSchema:{type:'object',properties:{a:{type:'string'},b:{type:'string'}},required:['a','b'],additionalProperties:false},execute:async()=>({status:'completed',summary:'已完成'})});
  const d=f.f.behaviors.definition(f.agent,'two-fields'),next=choiceOpportunity([{kind:'behavior',question:'检查字段',behaviorId:d.id,behaviorFingerprint:d.fingerprint,behaviorInput:{a:'a',b:'b'}}]),task=taskFor(f,next);
  assert.equal(resolveBehaviorChoice(f.agent,task,{opportunityId:next.opportunities[0].opportunityId,plan:{decision:'execute',question:'检查字段',value:'保持输入一致',input:{b:'b',a:'a'}}}).selected.behaviorId,d.id);
});

await test('Selection admission does not reserve an invented executor request',async f=>{
  const {estimateTaskBudget}=await import('../plugins/become-human/autonomy.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');f.f.reminders=new ReminderStore(f.j);f.f.config={};f.register();const next=choiceOpportunity(f.f.behaviors.opportunities(f.agent,{})),task=taskFor(f,next),cost=estimateTaskBudget(f.agent,task);assert.equal(cost.requests,1);assert.equal(cost.executor,0);assert.equal(cost.tokens,cost.selection);
});
await test('MCP grants require a separate explicit autonomous flag',async()=>{
  const {normalizeCustomMcpServer}=await import('../plugins/become-human/capability-mcp-config.mjs');const server={id:'autonomy',transport:'http',url:'https://example.org/mcp',enabled:true,tools:[{name:'read_index',description:'Read index',inputSchema:schema,schemaHash:'a'.repeat(64),effect:'read',enabled:true}]};assert.equal(normalizeCustomMcpServer(server).tools[0].autonomous,false);server.tools[0].autonomous=true;assert.equal(normalizeCustomMcpServer(server).tools[0].autonomous,true);server.tools[0].autonomous='yes';assert.throws(()=>normalizeCustomMcpServer(server),/INVALID_CUSTOM_MCP_SETTINGS/);
});
await test('Selection action contract derives approval from actual enabled capability policy',async f=>{
  const {opportunityActionContract}=await import('../plugins/become-human/behavior-selection.mjs');
  f.f.tools.register('approval-test',{description:'受管写入',inputSchema:schema,effect:'write',autonomous:true,execute:async()=>({ok:true})});
  const next={kind:'behavior',behaviorId:'tool.approval-test',behaviorDefinition:{effect:'read'}};
  assert.deepEqual(opportunityActionContract(f.agent,next),{effect:'write',selectionAction:'prepare-approval',executionRequiresApproval:true});
  assert.equal(opportunityActionContract(f.agent,{kind:'behavior',behaviorId:'tool.missing'}),null);
  assert.equal(opportunityActionContract(f.agent,{kind:'chat'}),null);
  assert.equal(opportunityActionContract(f.agent,{kind:'behavior',behaviorId:'tool.read-public-page'}).selectionAction,'execute-read');
});
await test('Silence reduces outreach while preserving independent private curiosity',async f=>{
  const {commitLearningOffer,routeDisposition,studyDisposition}=await import('../plugins/become-human/learning-engagement.mjs');const now=Date.now(),question='咖啡研磨粗细与萃取',quote='Grind size changes the extraction conditions for coffee.';
  const task=taskFor(f,{kind:'research',question},{}),noteId=f.f.autonomy.commitNote(f.id,task,{url:'https://example.org/coffee',digest:'a'.repeat(64),excerpt:quote,fetchedAt:now,partial:false},{title:question,summary:quote,claims:[{text:quote,quote}],relevance:'了解研磨条件'}),note=f.f.autonomy.note(f.id,noteId),messageId=randomUUID(),text='最近在看咖啡研磨粗细，有一个小发现。';f.j.publish(f.id,text,'assistant','assistant:'+messageId,now);
  assert.equal(commitLearningOffer(f.j,f.id,{messageId,noteId,sourceId:note.source_id,ownerAnchor:'initial',at:now,text,question,routeText:question}).committed,true);
  const later=now+25*3600000,contact=routeDisposition(f.j,f.f.domain,f.id,question,later),study=studyDisposition(f.j,f.f.domain,f.id,question,later);assert.equal(contact.reason,'no-follow-up');assert(contact.weight<1);assert.equal(study.weight,1);assert.equal(study.outreachWeight,contact.weight);
});

await test('New task IDs cannot replay failed or unknown capability operations',async f=>{
  let calls=0;f.f.tools.register('unstable-read',{description:'合成失败读取',inputSchema:schema,effect:'read',autonomous:true,execute:async()=>{calls++;if(calls===1)throw Error('READ_FAILED');return {ok:true};}});syncCapabilityBehaviors(f.f,f.id);
  const d=f.f.behaviors.definition(f.agent,'tool.unstable-read'),next={kind:'behavior',question:'读取当前索引',behaviorId:d.id,behaviorFingerprint:d.fingerprint},t=taskFor(f,next,{input:{value:'index'}});
  assert.equal((await f.f.behaviors.execute(f.agent,t,context)).status,'failed');const fresh=taskFor(f,next,{input:{value:'index'}});assert.equal((await f.f.behaviors.execute(f.agent,fresh,context)).error,'CAPABILITY_RETRY_REQUIRED');assert.equal(calls,1);
  // This is the same explicit management retry marker used by autonomy-retry-task.
  t.checkpoint.roundId=randomUUID();assert.equal((await f.f.behaviors.execute(f.agent,t,context)).status,'completed');assert.equal(calls,2);
  f.f.tools.register('uncertain-write',{description:'合成不明写入',inputSchema:schema,effect:'write',autonomous:true,execute:async()=>{throw Error('SHOULD_NOT_DISPATCH');}});syncCapabilityBehaviors(f.f,f.id);
  const wd=f.f.behaviors.definition(f.agent,'tool.uncertain-write'),wn={kind:'behavior',question:'受管写入',behaviorId:wd.id,behaviorFingerprint:wd.fingerprint},w=taskFor(f,wn,{input:{value:'same-item'}}),waiting=await f.f.behaviors.execute(f.agent,w,context);assert.equal(waiting.status,'waiting');
  // Synthetic unknown outcome, no real external write and no approval bypass.
  f.f.tools.update(f.f.tools.get(f.id,waiting.jobId),'unknown',{error:'CAPABILITY_OUTCOME_UNKNOWN'});assert.equal((await f.f.behaviors.execute(f.agent,w,context)).status,'unknown');const w2=taskFor(f,wn,{input:{value:'same-item'}});assert.equal((await f.f.behaviors.execute(f.agent,w2,context)).error,'CAPABILITY_OUTCOME_UNKNOWN');w.checkpoint.roundId=randomUUID();assert.equal((await f.f.behaviors.execute(f.agent,w,context)).error,'CAPABILITY_OUTCOME_UNKNOWN');
});


await test('Generic planner does not inherit outreach output instructions',async f=>{
  const {behaviorSelectionMessages}=await import('../plugins/become-human/behavior-selection.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');f.f.reminders=new ReminderStore(f.j);f.f.config={};f.register();
  const t=taskFor(f,choiceOpportunity(f.f.behaviors.opportunities(f.agent,{}))),messages=behaviorSelectionMessages(f.agent,t,f.f.domain.persona(f.id)),system=messages[0].content[0].text;
  assert(!system.includes('这是一次轻轻带起话题的引子'));assert(!system.includes('最多120字'));assert(system.includes('只约束主动沟通'));assert(system.includes('合法 JSON'));
});
await test('Neutral steps under a development goal cannot become persona experience',async f=>{
  f.register();const source=randomUUID();f.f.domain.source(f.id,{id:source,kind:'configuration',body:JSON.stringify({goalDescription:'【开发测试】验证通用工作流程'})});
  assert(f.f.domain.sourceIsDevelopmentTest(f.id,source));
  const g=f.f.goals.propose(f.id,{description:'【开发测试】验证通用工作流程',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'目录'},question:'整理资料目录'}]});
  const d=f.f.behaviors.definition(f.agent,'make-index'),t=taskFor(f,{kind:'behavior',behaviorId:d.id,behaviorFingerprint:d.fingerprint,question:'整理资料目录',goal:{id:g.id,stepId:g.steps[0].id,version:g.version}},{input:{value:'目录'},question:'整理资料目录',value:'方便查找'});
  f.f.autonomy.update(t.id,'completed',{...t.checkpoint,behaviorResult:await f.f.behaviors.execute(f.agent,t,context)});const e=f.f.experience.recordTask(f.id,t.id);assert(e.data.development);assert.equal(e.source,null);assert.equal(f.f.experience.context(f.id).experiences.length,0);
});
await test('Previously misclassified development receipt stops influencing context without deleting history',async f=>{
  f.register();const source=randomUUID();f.f.domain.source(f.id,{id:source,kind:'configuration',body:JSON.stringify({goalDescription:'【开发测试】旧目标'})});
  const g=f.f.goals.propose(f.id,{description:'【开发测试】旧目标',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'目录'},question:'整理资料目录'}]});
  const d=f.f.behaviors.definition(f.agent,'make-index'),t=taskFor(f,{kind:'behavior',behaviorId:d.id,behaviorFingerprint:d.fingerprint,question:'整理资料目录',goal:{id:g.id,stepId:g.steps[0].id,version:g.version}},{input:{value:'目录'},question:'整理资料目录',value:'方便查找'});f.f.autonomy.update(t.id,'completed',{...t.checkpoint,behaviorResult:await f.f.behaviors.execute(f.agent,t,context)});
  const classify=f.f.domain.sourceIsDevelopmentTest;f.f.domain.sourceIsDevelopmentTest=()=>false;const e=f.f.experience.recordTask(f.id,t.id);assert(e.source);f.f.domain.sourceIsDevelopmentTest=classify;
  assert.equal(f.f.experience.context(f.id).experiences.length,0);assert.equal(f.f.experience.sourceEvidence(f.id,e.source),null);assert(f.f.experience.get(f.id,e.id));
});


await test('Fixed authorized inputs are assembled by the kernel without asking the model to copy them',f=>{
  f.register();const d=f.f.behaviors.definition(f.agent,'make-index'),next=choiceOpportunity([{kind:'behavior',question:'整理资料',behaviorId:d.id,behaviorFingerprint:d.fingerprint,behaviorInput:{value:'资料'}}]),task=taskFor(f,next),choice={opportunityId:next.opportunities[0].opportunityId,plan:{decision:'execute',question:'整理资料',value:'方便查找'}};
  assert.deepEqual(resolveBehaviorChoice(f.agent,task,choice).plan.input,{value:'资料'});assert.equal(choice.plan.input,undefined);
  assert.throws(()=>resolveBehaviorChoice(f.agent,task,{...choice,plan:{...choice.plan,input:{value:'其他资料'}}}),/BEHAVIOR_INPUT_CHANGED/);
  delete task.checkpoint.opportunities[0].behaviorInput;assert.throws(()=>resolveBehaviorChoice(f.agent,task,choice),/INVALID_TOOL_INPUT/);
});


await test('Fixed goal direction comes from its selected opportunity, not a second model copy',f=>{
  f.register();const d=f.f.behaviors.definition(f.agent,'make-index'),next=choiceOpportunity([{kind:'behavior',question:'已确认方向',goal:{id:'goal-fixture'},behaviorId:d.id,behaviorFingerprint:d.fingerprint,behaviorInput:{value:'资料'}}]),task=taskFor(f,next);
  const chosen=resolveBehaviorChoice(f.agent,task,{opportunityId:next.opportunities[0].opportunityId,plan:{decision:'execute',value:'方便查找'}});assert.equal(chosen.plan.question,'已确认方向');assert.deepEqual(chosen.plan.input,{value:'资料'});
});


await test('No-goal behavior with bound input exposes and uses its provider direction',async f=>{
 f.register();const d=f.f.behaviors.definition(f.agent,'make-index'),next=choiceOpportunity([{kind:'behavior',question:'整理这批资料',behaviorId:d.id,behaviorFingerprint:d.fingerprint,behaviorInput:{value:'资料'}}]),task=taskFor(f,next);
 const {behaviorSelectionMessages}=await import('../plugins/become-human/behavior-selection.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');new ReminderStore(f.j);
 const data=JSON.parse(behaviorSelectionMessages(f.agent,task,f.f.domain.persona(f.id))[1].content[0].text);assert.equal(data.opportunities[0].fixedDirection,true);assert.equal(data.opportunities[0].goal,null);
 const resolved=resolveBehaviorChoice(f.agent,task,{opportunityId:next.opportunities[0].opportunityId,plan:{decision:'execute',value:'减少查找成本'}});assert.equal(resolved.plan.question,'整理这批资料');assert.deepEqual(resolved.plan.input,{value:'资料'});
 assert.throws(()=>resolveBehaviorChoice(f.agent,task,{opportunityId:next.opportunities[0].opportunityId,plan:{decision:'execute',question:'擅自换方向',value:'用途'}}),e=>e.validationDiagnostic?.reason==='fixed-direction-changed');
});
await test('Free behavior still keeps a model-defined direction and input',f=>{
 f.register();const next=choiceOpportunity(f.f.behaviors.opportunities(f.agent,{})),task=taskFor(f,next),plan={decision:'execute',question:'由模型决定的当前方向',value:'实际用途',input:{value:'自选参数'}};
 assert.deepEqual(resolveBehaviorChoice(f.agent,task,{opportunityId:next.opportunities[0].opportunityId,plan}).plan,plan);
});
await test('Rejected model plans remain selection attempts instead of orphan goal tasks',async f=>{
  const {runAutonomyTurn}=await import('../plugins/become-human/autonomy.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs'),{SafetyLedger}=await import('../plugins/become-human/safety.mjs');
  f.f.reminders=new ReminderStore(f.j);f.j.safety=await SafetyLedger.open(path.join(f.dir,'safety'));
  try{
    await f.f.autonomy.configure(f.id,{enabled:true,learningEnabled:false,searchEnabled:false,socialEnabled:false,proactiveEnabled:false,quotaEnabled:false});f.register();f.j.set(f.id,'running');f.j.put(f.id,'remaining',null);const events=[];f.agent.session={id:f.id,snapshotEvents:()=>events,append(type,data){events.push({type,data,time:Date.now()})}};f.agent.inbox={nextStep:[],nextTurn:[]};f.agent.flush=async()=>{};f.agent.desired=()=>f.j.get(f.id);f.f.config={provider:'synthetic',model:'synthetic',domainEnabled:true};f.f.tickets=new WeakMap();f.f.allowCall=async()=>{};
    const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'请整理资料'});let g=f.f.goals.propose(f.id,{description:'整理资料',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'目录'},question:'整理资料目录'}]});g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});
    f.agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall:async()=>({config:{provider:'synthetic',model:'synthetic'},context:{maxTokens:65536},stream:async function*(input){const data=JSON.parse(input.messages[1].content[0].text),op=data.opportunities.find(x=>x.goal);assert.equal(op.commitment.status,'active');yield {type:'text-delta',text:JSON.stringify({opportunityId:op.opportunityId,plan:{decision:'execute',value:'方便查找',invalidExtraField:true}})};yield {type:'usage',usage:{inputTokens:100,outputTokens:30}};yield {type:'finish',reason:{kind:'stop'}};}})}};
    await runAutonomyTurn(f.agent,new AbortController().signal);const task=f.j.db.prepare('SELECT kind,status,checkpoint FROM autonomy_task WHERE agent=? ORDER BY created DESC LIMIT 1').get(f.id);assert.equal(task.kind,'behavior-choice');assert.equal(task.status,'failed');assert.equal(JSON.parse(task.checkpoint).goal,undefined);assert.equal(f.f.goals.get(f.id,g.id).steps[0].taskId,null);
  }finally{f.j.safety.close()}
});

await test('Planner sees current goal progress rather than inferring completion from familiar content',async f=>{
  const {behaviorSelectionMessages}=await import('../plugins/become-human/behavior-selection.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');f.f.reminders=new ReminderStore(f.j);f.f.config={};f.register();
  const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'请重新核对当前资料索引。'});
  let goal=f.f.goals.propose(f.id,{description:'重新核对索引',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'make-index',input:{value:'资料'},question:'重新核对当前索引'}]});goal=f.f.goals.transition(f.id,goal.id,'activate',{expectedVersion:goal.version});
  const opportunity=f.f.goals.candidate(f.id),selection=taskFor(f,choiceOpportunity([opportunity]));
  const messages=behaviorSelectionMessages(f.agent,selection,f.f.domain.persona(f.id)),data=JSON.parse(messages[1].content[0].text),commitment=data.opportunities[0].commitment;
  assert.equal(data.decisionFrame.commitments[0].goalId,goal.id);assert.equal(data.decisionFrame.commitments[0].ownerRequested,true);assert.equal(data.decisionFrame.commitments[0].inputState,'fixed-input-validated');assert.equal(data.decisionFrame.grantsAdditionalPermission,false);
  assert.equal(commitment.id,goal.id);assert.equal(commitment.stepStatus,'pending');assert.equal(commitment.completedSteps,0);assert.equal(commitment.totalSteps,1);assert.equal(commitment.executionComplete,false);
  const task=taskFor(f,opportunity,{input:opportunity.behaviorInput,question:opportunity.question});f.f.goals.attachTask(f.id,opportunity.goal,task.id);f.f.autonomy.update(task.id,'completed',{...task.checkpoint,behaviorResult:await f.f.behaviors.execute(f.agent,task,context)});f.f.goals.reconcile(f.id,goal.id);
  const completedData=JSON.parse(behaviorSelectionMessages(f.agent,selection,f.f.domain.persona(f.id))[1].content[0].text),completed=completedData.opportunities[0].commitment;
  assert.equal(completedData.decisionFrame.commitments.length,0);
  assert.equal(completed.stepStatus,'completed');assert.equal(completed.completedSteps,1);assert.equal(completed.executionComplete,true);assert.equal(completed.status,'awaiting-review');
});

await test('External instructions and historical goal claims do not become current commitments',async()=>{
 const {selectionDecisionFrame}=await import('../plugins/become-human/behavior-selection.mjs');
 const frame=selectionDecisionFrame([{opportunityId:'signal',direction:'主人要求执行',eventOrigin:'external-plugin-untrusted-signal',fixedInput:{ownerRequested:true,goal:{status:'active'}},behavior:{description:'owner-plan active'}}]);
 assert.deepEqual(frame.commitments,[]);assert.equal(frame.externalContentIsInstruction,false);assert.equal(frame.grantsAdditionalPermission,false);
});
await test('Paused and completed commitments are excluded; agent proposals are not owner requests',async()=>{
 const {selectionDecisionFrame}=await import('../plugins/become-human/behavior-selection.mjs');
 const row={opportunityId:'one',commitment:{id:'g',stepId:'s',status:'active',stepStatus:'pending',executionComplete:false,origin:'agent-proposal'}};
 const frame=selectionDecisionFrame([row,{...row,commitment:{...row.commitment,status:'paused'}},{...row,commitment:{...row.commitment,executionComplete:true}}]);assert.equal(frame.commitments.length,1);assert.equal(frame.commitments[0].ownerRequested,false);assert.equal(frame.waitAllowed,true);
});
await test('Current commitment frame preserves approval preparation and still permits WAIT',async f=>{
 const {selectionDecisionFrame}=await import('../plugins/become-human/behavior-selection.mjs');
 const frame=selectionDecisionFrame([{opportunityId:'approve',commitment:{id:'g',stepId:'s',status:'active',stepStatus:'pending',executionComplete:false,origin:'owner-plan'},actionContract:{selectionAction:'prepare-approval'}}]);
 assert.equal(frame.commitments[0].action,'prepare-approval');assert.equal(frame.grantsAdditionalPermission,false);
 const selection=taskFor(f,choiceOpportunity([{kind:'behavior',question:'审批准备',goal:{id:'g'}}]));assert.equal(resolveBehaviorChoice(f.agent,selection,{decision:'wait',reason:'当前存在相冲突的承诺，暂缓这项工作。'}).selected,null);
});

const {selectedTaskWorkflow}=await import('../plugins/become-human/autonomy-workflows.mjs');
const workflowContext=(f,task,extra={})=>({agent:f.agent,task,response:null,signal:new AbortController().signal,epoch:1,turn:1,valid(){},phase(value){f.j.put(f.id,'autonomyPhase',value)},...extra});
await test('Unknown persisted task kind cannot fall through to a contact model call',()=>{assert.throws(()=>selectedTaskWorkflow('unknown-task'),/AUTONOMY_WORKFLOW_UNAVAILABLE/);});
await test('Migrated contact WAIT completes its old task without publishing',async f=>{
 const task=taskFor(f,{kind:'care',question:'问候近况'},{question:'问候近况'}),ctx=workflowContext(f,task,{executeModel:async()=>({text:'[WAIT]',rid:randomUUID()})});
 await selectedTaskWorkflow('care').execute(ctx);assert.equal(ctx.response,null);assert.equal(f.f.autonomy.getTask(task.id).status,'completed');assert.equal(f.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(f.id).n,0);
});
await test('Migrated invalid contact output is quarantined and not returned for publication',async f=>{
 const task=taskFor(f,{kind:'care',question:'问候近况'},{question:'问候近况'}),ctx=workflowContext(f,task,{executeModel:async()=>({text:'not structured JSON',rid:randomUUID(),usage:{inputTokens:10,outputTokens:4}})});
 await selectedTaskWorkflow('care').execute(ctx);assert.equal(ctx.response,null);assert.equal(f.f.autonomy.getTask(task.id).status,'failed');assert.equal(f.j.value(f.id,'autonomyPaused',false),false);
});
await test('Preempted contact response remains available to shared accounting without publication',async f=>{
 const task=taskFor(f,{kind:'care',question:'问候近况'},{question:'问候近况'}),response={text:'[WAIT]',rid:randomUUID()},ctx=workflowContext(f,task,{executeModel:async()=>response,valid(){throw Error('STALE_RESULT')}});
 await assert.rejects(()=>selectedTaskWorkflow('care').execute(ctx),/STALE_RESULT/);assert.equal(ctx.response,response);assert.equal(f.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(f.id).n,0);
});
await test('Legacy research discovery checkpoint can suspend without invoking the model',async f=>{learning(f);
 const task=taskFor(f,{kind:'research',question:'核对资料'},{question:'核对资料',searchQuery:'test'});let calls=0;const ctx=workflowContext(f,task,{discoverSource:async()=>null,executeModel:async()=>{calls++;}});
 await selectedTaskWorkflow('research',f.agent).execute(ctx);assert.equal(calls,0);assert.equal(ctx.task.id,task.id);assert.equal(ctx.response,null);
});
await test('Persisted fixed source skips fetching and insufficient output never publishes',async f=>{learning(f);
 const task=taskFor(f,{kind:'learn-ai',question:'核对资料'},{question:'核对资料'});task.checkpoint.source={url:'https://example.org/',digest:'a'.repeat(64)};let rejected=0;
 const ctx=workflowContext(f,task,{executeModel:async()=>({text:'[WAIT]',rid:randomUUID()}),rejectInsufficientEvidence(){rejected++;}});
 assert.equal(await selectedTaskWorkflow('learn-ai',f.agent).prepare(ctx),true);await selectedTaskWorkflow('learn-ai',f.agent).execute(ctx);assert.equal(rejected,1);assert.equal(ctx.response,null);assert.equal(ctx.task.id,task.id);
});
await test('Migrated report preparation preserves the goal reference and only queues approval',async f=>{
 const task=taskFor(f,{kind:'write-report',question:'准备报告'},{question:'准备报告'});task.checkpoint.goal={id:'test-goal',stepId:'test-step'};task.checkpoint.reportProposal={requestId:'test-report-request',title:'测试报告',noteIds:['test-note']};let proposal,attached;
 f.f.actions={proposeReport(id,input){proposal=input;return {id:'test-action'}}};f.f.goals={attachAction(id,ref,actionId){attached={ref,actionId}}};const ctx=workflowContext(f,task);
 await selectedTaskWorkflow('write-report').execute(ctx);assert.deepEqual(proposal.goal,task.checkpoint.goal);assert.equal(attached.actionId,'test-action');assert.equal(f.f.autonomy.getTask(task.id).checkpoint.actionId,'test-action');assert.equal(ctx.response,null);assert.equal(f.j.value(f.id,'autonomyPhase'),'waiting-approval');
});
await test('Full event loop preserves WAIT and unrelated signals, then claims and completes only selected event',async f=>{
  const {PluginEvents}=await import('../plugins/become-human/plugin-events.mjs'),{apply}=await import('../docs/examples/human-signal-plugin/index.mjs'),{SafetyLedger}=await import('../plugins/become-human/safety.mjs'),{runAutonomyTurn}=await import('../plugins/become-human/autonomy.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');
  f.f.pluginEvents=new PluginEvents(f.j,{agentId:()=>f.id});f.f.autonomy.pluginEvents=f.f.pluginEvents;f.j.safety=await SafetyLedger.open(path.join(f.dir,'safety'));let cleanup,emit;
  try{
    apply({humanEvents:f.f.pluginEvents,humanBehaviors:f.f.behaviors,effect:fn=>{cleanup=fn();},on:(_name,fn)=>{emit=fn;return ()=>{};}});f.register();
    const now=Date.now();emit({key:'fixture',occurredAt:now,expiresAt:now+3600000,payload:{title:'【开发测试】检查变化',detail:'不是用户偏好'}});
    await f.f.autonomy.configure(f.id,{enabled:true,learningEnabled:false,searchEnabled:false,socialEnabled:false,proactiveEnabled:false,quotaEnabled:false});f.f.reminders=new ReminderStore(f.j);f.j.set(f.id,'running');f.j.put(f.id,'remaining',null);const events=[];let choice='wait';
    f.agent.session={id:f.id,snapshotEvents:()=>events,append(type,data){events.push({type,data,time:Date.now()})}};f.agent.inbox={nextStep:[],nextTurn:[]};f.agent.flush=async()=>{};f.agent.desired=()=>f.j.get(f.id);f.f.config={provider:'synthetic',model:'synthetic',domainEnabled:true};f.f.tickets=new WeakMap();f.f.allowCall=async()=>{};
    f.agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall:async()=>({config:{provider:'synthetic',model:'synthetic'},context:{maxTokens:65536},stream:async function*(input){const opportunities=JSON.parse(input.messages[1].content[0].text).opportunities,op=opportunities.find(x=>choice==='event'?x.eventIds.length:x.behavior?.id==='make-index'),result=choice==='wait'?{decision:'wait',reason:'本轮等待'}:{opportunityId:op.opportunityId,plan:{decision:'execute',question:op.direction,value:'检查有价值的变化',...(choice==='event'?{}:{input:{value:'目录'}})}};yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'usage',usage:{inputTokens:100,outputTokens:30}};yield {type:'finish',reason:{kind:'stop'}};}})}};
    await runAutonomyTurn(f.agent,new AbortController().signal);assert.equal(f.f.pluginEvents.status(f.id).pending,1);
    choice='unrelated';await runAutonomyTurn(f.agent,new AbortController().signal);assert.equal(f.f.pluginEvents.status(f.id).pending,1);
    choice='event';await runAutonomyTurn(f.agent,new AbortController().signal);const tasks=f.j.db.prepare("SELECT status,checkpoint FROM autonomy_task WHERE agent=? AND kind='behavior'").all(f.id),task=tasks.find(t=>JSON.parse(t.checkpoint).behaviorId==='example.review-signal');assert.equal(task?.status,'completed');assert.equal(f.f.pluginEvents.status(f.id).pending,0);assert.equal(f.f.pluginEvents.status(f.id).claimed,0);assert.equal(f.j.db.prepare('SELECT status FROM human_plugin_event WHERE agent=?').get(f.id).status,'handled');assert.equal(f.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(f.id).n,0);
  }finally{cleanup?.();f.j.safety.close();}
});
await test('Optional lightweight review uses the single model gate, settles two calls and writes no knowledge or messages',async f=>{
  const {PluginEvents}=await import('../plugins/become-human/plugin-events.mjs'),{apply}=await import('../docs/examples/human-signal-plugin/index.mjs'),{SafetyLedger}=await import('../plugins/become-human/safety.mjs'),{runAutonomyTurn}=await import('../plugins/become-human/autonomy.mjs'),{ReminderStore}=await import('../plugins/become-human/reminders.mjs');
  f.f.pluginEvents=new PluginEvents(f.j,{agentId:()=>f.id});f.f.autonomy.pluginEvents=f.f.pluginEvents;f.j.safety=await SafetyLedger.open(path.join(f.dir,'safety'));let cleanup,emit;
  try{
    apply({humanEvents:f.f.pluginEvents,humanBehaviors:f.f.behaviors,effect:fn=>{cleanup=fn();},on:(_name,fn)=>{emit=fn;return ()=>{};}},{reviewWithModel:true});f.register();
    const now=Date.now();emit({key:'fixture',occurredAt:now,expiresAt:now+3600000,payload:{title:'【开发测试】检查变化',detail:'不是用户偏好'}});
    await f.f.autonomy.configure(f.id,{enabled:true,learningEnabled:false,searchEnabled:false,socialEnabled:false,proactiveEnabled:false,quotaEnabled:false});f.f.reminders=new ReminderStore(f.j);f.j.set(f.id,'running');f.j.put(f.id,'remaining',null);const events=[];let calls=0,inflight=0,maxInflight=0;
    f.agent.session={id:f.id,snapshotEvents:()=>events,append(type,data){events.push({type,data,time:Date.now()})}};f.agent.inbox={nextStep:[],nextTurn:[]};f.agent.flush=async()=>{};f.agent.desired=()=>f.j.get(f.id);f.f.config={provider:'synthetic',model:'synthetic',domainEnabled:true};f.f.tickets=new WeakMap();f.f.allowCall=async()=>{};
    f.agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:0})},llm:{prepareCall:async()=>({config:{provider:'synthetic',model:'synthetic'},context:{maxTokens:65536},stream:async function*(input){calls++;inflight++;maxInflight=Math.max(maxInflight,inflight);try{const data=JSON.parse(input.messages[1].content[0].text),op=data.opportunities?.find(x=>x.eventIds.length);const result=op?{opportunityId:op.opportunityId,plan:{decision:'execute',question:op.direction,value:'理解变化是否值得进一步关注'}}:{observation:'材料声称有变化。',possibleValue:'可能有用，但尚未核实。',openQuestion:'具体发生了什么？',suggestedNextStep:'wait'};yield {type:'text-delta',text:JSON.stringify(result)};yield {type:'usage',usage:{inputTokens:100,outputTokens:30}};yield {type:'finish',reason:{kind:'stop'}};}finally{inflight--;}}})}};
    await runAutonomyTurn(f.agent,new AbortController().signal);const task=f.j.db.prepare("SELECT status,checkpoint FROM autonomy_task WHERE agent=? AND kind='behavior'").get(f.id);assert.equal(task.status,'completed');assert.equal(JSON.parse(task.checkpoint).behaviorResult.inference,true);assert.equal(calls,2);assert.equal(maxInflight,1);assert.equal(f.f.pluginEvents.status(f.id).pending,0);assert.equal(f.j.db.prepare('SELECT count(*) n FROM learning_note WHERE agent=?').get(f.id).n,0);assert.equal(f.j.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(f.id).n,0);const attempts=f.j.db.prepare('SELECT state FROM attempt WHERE agent=? ORDER BY started').all(f.id).map(r=>r.state);assert.deepEqual(attempts,['selected','executed']);assert.equal(f.j.db.prepare("SELECT count(*) n FROM reservation WHERE agent=? AND status='reserved'").get(f.id).n,0);

  }finally{cleanup?.();f.j.safety.close();}
});
await test('Fixed goal and ordinary copies merge without merging different inputs, evidence or matters',()=>{
 const normal={kind:'behavior',behaviorId:'observe',behaviorFingerprint:'v1',behaviorInput:{eventId:'one'},eventIds:['one'],question:'普通观察'},goal={...normal,goal:{id:'goal'},question:'目标观察'};
 const different=[{...normal,behaviorInput:{eventId:'two'},eventIds:['two']},{...normal,behaviorFingerprint:'v2'},{...normal,eventIds:['other']},{...normal,matterId:'matter'}];
 for(const rows of [[normal,goal],[goal,normal]]){const choices=choiceOpportunity([...rows,...different]).opportunities;assert.equal(choices.length,5);assert.equal(choices.filter(c=>c.goal).length,1);assert(!choices.some(c=>!c.goal&&!c.matterId&&c.behaviorFingerprint==='v1'&&c.behaviorInput.eventId==='one'&&c.eventIds[0]==='one'));}
});
await test('Active goal carries event evidence into selection and owns the resulting task',async f=>{
 f.f.pluginEvents={valid:(_id,ids)=>ids.every(id=>id==='event-a')};
 f.f.behaviors.register('observe',{version:1,title:'观察',description:'观察指定条目',inputSchema:schema,eventsForInput:()=>['event-a'],opportunities:()=>[{question:'普通观察',input:{value:'A'},eventIds:['event-a']}],execute:async()=>({status:'completed',summary:'已观察'})});
 f.f.autonomy.events=()=>[{id:'event-a',kind:'plugin'}];const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'【开发测试】观察 A'});let g=f.f.goals.propose(f.id,{description:'【开发测试】观察 A',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'observe',input:{value:'A'},question:'【开发测试】目标观察'}]});g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});
 const next=await candidate(f.agent,context.signal,f.f.autonomy.settings(f.id)),observations=next.opportunities.filter(o=>o.behaviorId==='observe');assert.equal(observations.length,1);const op=observations[0];assert.equal(op.goal.id,g.id);assert.deepEqual(op.eventIds,['event-a']);
 const chosen=resolveBehaviorChoice(f.agent,taskFor(f,next),{opportunityId:op.opportunityId,plan:{decision:'execute',value:'履行承诺'}});const task=taskFor(f,chosen.selected,chosen.plan);f.f.goals.attachTask(f.id,op.goal,task.id);f.f.autonomy.update(task.id,'completed',{...task.checkpoint,behaviorResult:await f.f.behaviors.execute(f.agent,task,context)});f.f.goals.reconcile(f.id,g.id);assert.equal(f.f.goals.get(f.id,g.id).progress.completed,1);
});
await test('A goal with unavailable event input is held before selection and not replayed',async f=>{
 f.f.pluginEvents={valid:()=>false};f.f.behaviors.register('observe',{version:1,title:'观察',description:'观察指定条目',inputSchema:schema,eventsForInput:()=>['expired'],execute:async()=>({status:'completed',summary:'不会执行'})});const source=randomUUID();f.f.domain.source(f.id,{id:source,body:'【开发测试】过期来源'});let g=f.f.goals.propose(f.id,{description:'【开发测试】过期来源',refs:[source],expires:Date.now()+86400000,milestones:[{kind:'behavior',behaviorId:'observe',input:{value:'A'},question:'观察'}]});g=f.f.goals.transition(f.id,g.id,'activate',{expectedVersion:g.version});assert.equal(f.f.goals.candidate(f.id),null);assert.equal(f.f.goals.get(f.id,g.id).status,'blocked');assert.equal(f.f.goals.get(f.id,g.id).reason,'PLUGIN_EVENT_UNAVAILABLE');
});
const result={root,passed:cases.filter(row=>row.passed).length,failed:cases.filter(row=>!row.passed).length,cases,scope:'Isolated SQLite, no production changes, no model or IM calls.'};await fs.writeFile(process.env.BH_TEST_RESULT??path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,passed:result.passed,failed:result.failed}));hook.deregister();if(result.failed)process.exitCode=1;
