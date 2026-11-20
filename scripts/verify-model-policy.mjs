import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {modelRequest,requestCost} from '../plugins/become-human/model-gateway.mjs';
import {contextMessages,contextSettings} from '../plugins/become-human/context.mjs';
import {DomainMemory} from '../plugins/become-human/domain.mjs';
import {SafetyLedger} from '../plugins/become-human/safety.mjs';
import {quotaView} from '../plugins/become-human/quota.mjs';
import {modelCallOptions,executionSettings,autonomousBudgetEstimate} from '../plugins/become-human/model-policy.mjs';
import {AutonomyStore} from '../plugins/become-human/autonomy-store.mjs';
import {ControlJournal} from '../plugins/become-human/driver.mjs';
import {choiceDialogueRequest} from '../plugins/become-human/choice-dialogue.mjs';

// Actual request/context functions and signed quota ledger, synthetic adapter.
// No production, network, IM, DPAPI or real model use.
const tests=[];
async function test(name,run){let f;try{f=fixture();await run(f);tests.push({name,passed:true});}catch(e){tests.push({name,passed:false,error:e.stack});}finally{f?.db.close();f?.ledger.close();}}
function fixture(){
  const id=randomUUID(),db=new DatabaseSync(':memory:'),metadata=new Map(),audit=[],reservations=[],ends=[],stats={prepared:[],streams:0,signals:[]};
  db.exec('CREATE TABLE user_request(agent TEXT,message_id TEXT); CREATE TABLE autonomy_task(id TEXT,agent TEXT,kind TEXT,status TEXT,updated INTEGER,created INTEGER); CREATE TABLE reminder(id TEXT,agent TEXT,status TEXT,due_at INTEGER)');
  const ledger=new SafetyLedger('unused-in-memory');ledger.key=randomBytes(32);ledger.id=randomUUID();ledger.db=new DatabaseSync(':memory:');
  ledger.db.exec('CREATE TABLE instruction(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,kind TEXT,request_hash TEXT,data TEXT,previous TEXT,hash TEXT,phase TEXT)');ledger.reload();
  const policy={enabled:true,quotaEnabled:true,tokenQuotaEnabled:true,requestQuotaEnabled:true,roundQuotaEnabled:true,tokenLimit:1000000,requestLimit:20,roundLimit:10,budgetWindow:'utc-day'};
  const configure=patch=>{Object.assign(policy,patch);ledger.appendSync(randomUUID(),'autonomy-policy',{agent:id,settings:policy});};configure({});
  const journal={db,assertAdmitted(){},value:(_id,key,fallback)=>metadata.has(key)?metadata.get(key):fallback,put:(_id,key,value)=>metadata.set(key,value),audit:(_id,kind,data)=>audit.push({kind,data}),reserve(_id,amount,_limit,attempt){const rid=randomUUID();if(!ledger.reserveBudget(rid,id,amount,{budgetClass:attempt.request.budgetClass,created:attempt.request.budgetTime,roundId:attempt.request.roundId}))return undefined;reservations.push({rid,amount,request:attempt.request});return rid;},dispatchAttempt:rid=>ledger.dispatchBudget(rid),settle:(rid,total)=>ledger.settleBudget(rid,total),release:rid=>ledger.releaseBudget(rid),endAttempt:(rid,outcome)=>ends.push({rid,...outcome})};
  const domain=new DomainMemory(journal),controller=new AbortController(),desired={desired:'running',epoch:1};
  const config={provider:'fixture-provider',model:'fixture-model',maxTokens:64,requestTimeoutMs:1};
  let preparedConfig={provider:config.provider,model:config.model,maxTokens:32768},context={contextWindow:131072},reply='自然回复',onStream=null,prepareError=null,finishReason={kind:'stop'};
  const agent={id,factory:{journal,domain,config,tickets:new Map(),management:{options:()=>config},autonomy:{getTask:()=>null,budget:()=>quotaView(ledger,id,policy,Date.now()),settings:()=>({timeZoneOffsetMinutes:0,contactCooldownMs:0}),quiet:()=>false},allowCall:async()=>{}},desired:()=>desired,session:{snapshotEvents:()=>[]},ctx:{llm:{async prepareCall(options,signal){stats.prepared.push(options);stats.signals.push(signal);if(prepareError)throw prepareError;return {config:{...preparedConfig},context,inputModalities:['text'],async *stream(options){stats.streams++;assert.equal(options.signal,controller.signal);if(onStream)await onStream(options);options.signal.throwIfAborted();yield {type:'text-delta',text:reply};yield {type:'usage',usage:{inputTokens:10,outputTokens:20,totalTokens:30}};yield {type:'finish',reason:finishReason};}};}}}};
  const messages=[{role:'system',content:[{type:'text',text:'动态人物规则'}]},{role:'user',content:[{type:'text',text:'当前输入'}]}];
  const call=(lane='foreground',purpose)=>modelRequest(agent,controller.signal,{turn:1,epoch:1,lane,messages,purpose,taskId:lane==='foreground'?undefined:'task-fixture'});
  return {id,db,ledger,journal,domain,agent,controller,messages,call,stats,audit,ends,reservations,configure,metadata,setPrepared:(value,window)=>{preparedConfig=value;context=window;},setReply:value=>{reply=value;},setFinish:value=>{finishReason=value;},onStream:value=>{onStream=value;},prepareFailure:value=>{prepareError=value;}};
}
function streamFixture(f,frames){
  const prepare=f.agent.ctx.llm.prepareCall;
  f.agent.ctx.llm.prepareCall=async(...args)=>({
    ...await prepare(...args),
    async *stream(){yield* frames;}
  });
}
const stop={type:'finish',reason:{kind:'stop'}};
const textEnd=(index,text)=>({type:'block-end',index,block:{type:'text',text}});
await test('a terminal-only text block supplies the original selection exactly once',async f=>{
  const answer='{"decision":"wait","reason":"等待"}';
  streamFixture(f,[{type:'block-start',index:0,blockType:'text'},textEnd(0,answer),stop]);
  assert.equal((await f.call('selection')).text,answer);
  assert.equal(f.ends.at(-1).responseText,answer);
});
await test('a final snapshot replaces its deltas and duplicate closes are ignored',async f=>{
  streamFixture(f,[{type:'text-delta',text:'原文'},textEnd(0,'改正'),textEnd(0,'重复关闭'),
    {type:'text-delta',index:0,text:'迟到'}, {type:'text-delta',index:1,text:'完成'},stop]);
  assert.equal((await f.call()).text,'改正完成');
});
await test('reasoning-only completion stores numeric evidence without supplying a reply',async f=>{
  const thought='private-reasoning-fixture';
  streamFixture(f,[{type:'reasoning-delta',index:0,text:thought.slice(0,2)},
    {type:'block-end',index:0,block:{type:'reasoning',text:thought}},stop]);
  await assert.rejects(f.call('selection'),e=>e.code==='EMPTY_MODEL_OUTPUT'&&e.modelFailure?.lane==='selection');
  const end=f.ends.at(-1);
  assert.equal(end.failureFacts.reasoningChars,thought.length);
  assert.equal(end.failureFacts.textChars,0);
  assert.equal(end.failureFacts.finalTextChars,0);
  assert(!JSON.stringify(end).includes(thought));
  assert(!JSON.stringify(f.metadata.get('modelFailures')).includes(thought));
});
await test('reasoning and tools stay out of a delta-only answer; a finish signal is still required',async f=>{
  streamFixture(f,[{type:'reasoning-delta',text:'thought'},{type:'text-delta',text:'visible'},
    {type:'block-end',index:2,block:{type:'tool-call',arguments:'private-tool-argument'}}]);
  await assert.rejects(f.call('selection'),e=>e.code==='MODEL_EXECUTION_FAILED'&&e.modelFailure.category==='incomplete-stream');
  const end=f.ends.at(-1);
  assert.equal(end.responseText,'visible');
  assert.equal(end.failureFacts.textDeltaChars,7);
  assert.equal(end.failureFacts.reasoningChars,7);
  assert.equal(end.failureFacts.streamCounts.finish,0);
});
await test('empty terminal response remains failed but settles reported usage instead of full reservation',async f=>{
 f.setReply('');await assert.rejects(f.call('selection'),/EMPTY_MODEL_OUTPUT/);
 const end=f.ends.at(-1);assert.equal(end.state,'failed');assert.equal(end.usageConfidence,'reported');assert.equal(end.failureFacts.textChars,0);assert.equal(end.failureFacts.streamCounts.finish,1);
 assert.equal(f.agent.factory.autonomy.budget().reservedTokens,30);assert.equal(f.stats.streams,1);
});
await test('reported settlement survives ledger replay and repeated settlement cannot refund twice',async f=>{
 await f.call('selection');const rid=f.reservations[0].rid;
 assert.equal(f.agent.factory.autonomy.budget().reservedTokens,30);f.ledger.reload();
 assert.equal(f.agent.factory.autonomy.budget().reservedTokens,30);
 f.ledger.settleBudget(rid,0);assert.equal(f.agent.factory.autonomy.budget().reservedTokens,30);
 assert.throws(()=>f.ledger.settleBudget(rid,-1),/INVALID_REPORTED_USAGE/);
});
await test('unknown stream failure retains its reservation even if partial usage arrived',async f=>{
 f.setFinish({kind:'error'});await assert.rejects(f.call('selection'),/MODEL_EXECUTION_FAILED/);
 assert.equal(f.agent.factory.autonomy.budget().reservedTokens,f.reservations[0].amount);
 assert.equal(f.ends.at(-1).usageConfidence,'unknown');
});
await test('obsolete request controls do not reach the adapter',async f=>{await f.call();assert.deepEqual(f.stats.prepared[0],{provider:'fixture-provider',model:'fixture-model'});assert.equal(f.stats.signals[0],f.controller.signal);assert.equal(f.reservations[0].request.outputReservation,32768);});
await test('reasoning selection survives without output or deadline overrides',()=>assert.deepEqual(modelCallOptions({provider:'p',model:'m',reasoningEffort:'high',maxTokens:64,requestTimeoutMs:1}),{provider:'p',model:'m',reasoningEffort:'high'}));
await test('obsolete persisted controls are ignored while retrieval stays configured',()=>{const e=executionSettings({maxTokens:64,requestTimeoutMs:1,context:{memoryLimit:17,historyLimit:12,learningLimit:5,foregroundInputBudget:4096,selectionInputBudget:4096,executorInputBudget:4096},reasoningEffort:'high'});assert.equal(e.maxTokens,undefined);assert.equal(e.requestTimeoutMs,undefined);assert.deepEqual(e.context,{memoryLimit:17,historyLimit:12,learningLimit:5});assert.equal(e.reasoningEffort,'high');});
await test('actual model output exceeding old byte limits is retained',async f=>{f.setReply('长'.repeat(12000));const result=await f.call();assert.equal(result.text.length,12000);assert.equal(f.stats.streams,1);});
await test('summary generation follows the same host defaults',async f=>{await f.call('foreground','conversation-summary');assert.equal(f.stats.prepared[0].maxTokens,undefined);assert.equal(f.stats.signals[0],f.controller.signal);assert.equal(f.reservations[0].request.purpose,'conversation-summary');});
await test('style editing uses the foreground ledger and does not attach current owner images',async f=>{
 f.configure({tokenLimit:1});f.agent.factory.media={current(){throw Error('STYLE_EDITOR_MUST_NOT_READ_IMAGES');}};
 await modelRequest(f.agent,f.controller.signal,{turn:1,epoch:1,lane:'foreground',messages:f.messages,admittedIds:[randomUUID()],purpose:'conversation-style-repair'});assert.equal(f.stats.streams,1);assert.equal(f.reservations[0].request.budgetClass,'foreground');assert.equal(f.reservations[0].request.purpose,'conversation-style-repair');assert.equal(f.ends.at(-1).state,'completed');assert.equal(f.stats.signals[0],f.controller.signal);
});
await test('foreground remains usable after autonomous token budget is exhausted',async f=>{f.configure({tokenLimit:1});await f.call();assert.equal(f.stats.streams,1);assert.equal(f.ledger.autonomyEntries(f.id,0).length,0);assert.equal(f.reservations[0].request.budgetClass,'foreground');});
await test('autonomous calls retain the resolved provider output reservation',async f=>{await f.call('selection');assert.equal(f.reservations[0].amount,requestCost(f.messages,{maxTokens:32768}));assert.equal(f.ledger.autonomyEntries(f.id,0).length,1);assert.equal(f.ends.at(-1).usageConfidence,'reported');});
await test('autonomous token exhaustion preserves the actual host-resolved amount for grants',async f=>{f.configure({tokenLimit:1000});await assert.rejects(f.call('executor'),e=>e.message==='AUTONOMOUS_BUDGET_EXHAUSTED'&&e.neededTokens===requestCost(f.messages,{maxTokens:32768}));assert.equal(f.stats.streams,0);assert.equal(f.ledger.autonomyEntries(f.id,0).length,0);});
await test('grant request includes the refused host reservation instead of an obsolete small forecast',async f=>{
  f.configure({tokenLimit:1000});let failure;
  try{await f.call('executor');}catch(e){failure=e;}
  assert(failure?.neededTokens>32768);
  const estimate=autonomousBudgetEstimate({tokens:2000,requests:2},failure.neededTokens);
  const journal=new ControlJournal(':memory:');journal.safety=f.ledger;
  try{
    const store=new AutonomyStore(journal,new DomainMemory(journal)),request=store.requestBudget(f.id,'new-task',estimate);
    assert.equal(request.suggestedTokens,failure.neededTokens-1000);assert.equal(request.remainingTaskRequests,2);
    assert.equal(request.estimateKind,'includes-next-host-resolved-request');assert.equal(f.stats.streams,0);
  }finally{journal.close();}
});
await test('autonomous request exhaustion still blocks dispatch',async f=>{f.configure({requestLimit:1});await f.call('selection');await assert.rejects(f.call('executor'),/AUTONOMOUS_BUDGET_EXHAUSTED/);assert.equal(f.stats.streams,1);});
await test('host window supplies the reservation when output default is unspecified',async f=>{f.setPrepared({provider:'fixture-provider',model:'fixture-model'},{contextWindow:65536});await f.call('executor');assert.equal(f.reservations[0].request.outputReservation,65536);assert.equal(f.stats.prepared[0].maxTokens,undefined);});
await test('unknown capacity cannot silently bypass an enabled autonomous token budget',async f=>{f.setPrepared({provider:'fixture-provider',model:'fixture-model'},undefined);await assert.rejects(f.call('executor'),/MODEL_BUDGET_ESTIMATE_UNAVAILABLE/);assert.equal(f.stats.streams,0);assert.equal(f.reservations.length,0);});
await test('disabled autonomous token budgeting needs no fabricated output bound',async f=>{f.configure({tokenQuotaEnabled:false});f.setPrepared({provider:'fixture-provider',model:'fixture-model'},undefined);await f.call('executor');assert.equal(f.stats.streams,1);assert.equal(f.reservations[0].request.outputReservation,null);});
await test('parent cancellation remains effective without a Human request timer',async f=>{f.onStream(()=>f.controller.abort());await assert.rejects(f.call(),/USER_PREEMPTED/);assert.equal(f.ends.at(-1).state,'cancelled');assert.equal(f.ends.at(-1).usageConfidence,'unknown');assert.equal(f.reservations.length,1);});
await test('adapter preparation failures leave no charged reservation',async f=>{f.prepareFailure(new TypeError('synthetic adapter failure'));await assert.rejects(f.call(),/MODEL_EXECUTION_FAILED/);assert.equal(f.stats.streams,0);assert.equal(f.reservations.length,0);assert(f.audit.some(row=>row.kind==='model-preparation-rejected'));});
await test('large foreground required evidence survives obsolete context budgets',f=>{f.metadata.set('humanExecution',{context:{foregroundInputBudget:4096,selectionInputBudget:4096,executorInputBudget:4096}});const source='资料'.repeat(100000),data={persona:{version:1,core:'当前人物',profile:{name:'动态角色'}},input:[],history:[],currentEvidence:source};const messages=contextMessages(f.agent,'foreground','规则',data);assert(messages.contextReport.estimatedInput>262144);assert.equal(messages.contextReport.budget,null);assert.equal(messages.contextReport.localInputLimit,false);assert.equal(JSON.parse(messages[1].content[0].text).currentEvidence,source);assert.equal(contextSettings(f.journal,f.id).foregroundInputBudget,undefined);});
await test('selection and executor accept large required evidence without a local cap',f=>{for(const lane of ['selection','executor']){const source='来源'.repeat(60000),messages=contextMessages(f.agent,lane,'规则',{persona:{version:1,core:'当前人物'},source:{body:source},input:[]});assert.equal(messages.contextReport.budget,null);assert.equal(JSON.parse(messages[1].content[0].text).source.body,source);}});
await test('natural reply envelope does not restore the removed output cap',async f=>{f.agent.factory.dialogueState={context:()=>null};f.agent.factory.relationship={settings:()=>({enabled:false})};const text='自然解释'.repeat(3000),messages=contextMessages(f.agent,'foreground','规则',{persona:{version:1,core:'当前人物'},input:[]}),response=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:JSON.stringify({reply:text})}))(f.agent,f.controller.signal,{messages});assert.equal(response.text.length,text.length);assert(response.text===text);});
await test('upstream finish status survives without persisting supplier error text',async f=>{const privateText='sk-'+('x'.repeat(28));f.setFinish({kind:'error',failure:{status:429,code:'SUPPLIER_PRIVATE_CODE',message:privateText}});await assert.rejects(f.call('selection'),/MODEL_EXECUTION_FAILED/);assert.equal(f.ends.at(-1).failureFacts.httpStatus,429);assert.equal(f.ends.at(-1).failureFacts.streamFinish,'error');assert(!JSON.stringify(f.ends).includes(privateText));assert(!JSON.stringify(f.ends).includes('SUPPLIER_PRIVATE_CODE'));});
await test('invalid supplier status is not persisted as a valid HTTP failure',async f=>{f.setFinish({kind:'error',failure:{status:900,message:'untrusted'}});await assert.rejects(f.call(),/MODEL_EXECUTION_FAILED/);assert.equal(f.ends.at(-1).failureFacts.httpStatus,undefined);});
await test('a provider output finish remains distinct without restoring a local limit',async f=>{f.setFinish({kind:'max-tokens'});await assert.rejects(f.call(),/OUTPUT_LIMIT/);assert.equal(f.ends.at(-1).failureFacts.streamFinish,'max-tokens');assert.equal(f.stats.prepared[0].maxTokens,undefined);});
await test('provider failure is visible with route and survives a different lane success',async f=>{f.setFinish({kind:'error',failure:{status:404,code:'MODEL_NOT_FOUND',message:'Model fixture-model does not exist'}});await assert.rejects(f.call('selection'),/MODEL_EXECUTION_FAILED/);const row=f.metadata.get('modelFailures').selection;assert.equal(row.category,'model-unavailable');assert.equal(row.model,'fixture-model');assert.equal(row.httpStatus,404);assert.equal(row.attemptId,f.ends.at(-1).rid);f.setFinish({kind:'stop'});await f.call('foreground');assert(f.metadata.get('modelFailures').selection);await f.call('selection');assert(!f.metadata.get('modelFailures').selection);});
await test('generated draft survives failed review with one accurate degradation notification',async f=>{
 const notices=[];f.agent.factory.journal.publish=(...args)=>notices.push(args);f.agent.factory.dialogueState={context:()=>null};f.agent.factory.relationship={settings:()=>({enabled:false})};f.agent.factory.conversationReview=true;
 f.setReply(JSON.stringify({reply:'我在，慢慢说。'}));f.onStream(()=>{if(f.stats.streams===2){f.setReply('');f.setFinish({kind:'error',failure:{message:'Stream ended without finish_reason'}});}});
 const messages=contextMessages(f.agent,'foreground','规则',{persona:{version:1,core:'当前人物'},input:[]});
 const result=await choiceDialogueRequest(modelRequest)(f.agent,f.controller.signal,{turn:1,epoch:1,lane:'foreground',messages});
 const failure=f.metadata.get('modelFailures').foreground;
 assert.equal(f.stats.streams,2);assert.equal(failure.purpose,'conversation-review');assert.equal(failure.category,'incomplete-stream');assert.equal(failure.textChars,0);
 assert.equal(result.text,'我在，慢慢说。');assert.equal(result.dialogueQuality.causeAttemptId,failure.attemptId);assert.equal(result.dialogueQuality.status,'review-unavailable');assert(!f.ends.some(row=>row.error==='CONVERSATION_REVIEW_UNAVAILABLE'));assert.equal(notices.length,1);assert.equal(notices[0][2],'model-error');assert.match(notices[0][1],/基础校验继续处理/);assert(!notices[0][1].includes('尚未投递'));
});
const report={at:new Date().toISOString(),scope:'Synthetic adapter plus actual request, context, choice and signed quota functions; no production/model/IM.',passed:tests.filter(t=>t.passed).length,failed:tests.filter(t=>!t.passed).length,cases:tests};console.log(JSON.stringify(report));if(report.failed)process.exitCode=1;
