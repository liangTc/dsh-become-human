import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
// Optional pinned installed dependency anchor for an offline source checkout.
// Only bare imports fall back; maintained relative source imports stay intact.
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR;
const hook=anchor?registerHooks({resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||specifier.startsWith('.')||specifier.startsWith('/')||specifier.includes(':'))throw error;return next(specifier,{...context,parentURL:pathToFileURL(anchor).href});}}}):null;
const {ControlJournal,HumanAgent}=await import('../plugins/become-human/driver.mjs');
hook?.deregister();
const {DomainMemory}=await import('../plugins/become-human/domain.mjs');
const {ToolExecutor}=await import('../plugins/become-human/tool-executor.mjs');
const {capabilityDialogue}=await import('../plugins/become-human/capability-dialogue.mjs');
const {usageStatistics}=await import('../plugins/become-human/usage-statistics.mjs');
const {choiceDialogueRequest}=await import('../plugins/become-human/choice-dialogue.mjs');
const {modelRequest}=await import('../plugins/become-human/model-gateway.mjs');
const {RemoteGateway}=await import('../plugins/become-human-web/remote.mjs');
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'bh-attempts-')),tests=[];
async function test(name,fn){let f;try{f=fixture();await fn(f);tests.push({name,passed:true});}catch(e){tests.push({name,passed:false,error:e.stack});}finally{f?.journal.close();}}
function fixture(){
 const id=randomUUID(),file=path.join(root,id+'.sqlite');let journal=new ControlJournal(file);journal.ensure(id);journal.set(id,'running');
 journal.db.exec('CREATE TABLE learning_note(id TEXT PRIMARY KEY,agent TEXT,memory_id TEXT,source_id TEXT,data TEXT,status TEXT,created INTEGER,feedback TEXT);CREATE TABLE autonomy_task(id TEXT,agent TEXT,kind TEXT,status TEXT,updated INTEGER,created INTEGER);CREATE TABLE reminder(id TEXT,agent TEXT,status TEXT,due_at INTEGER)');
 const domain=new DomainMemory(journal),tools=new ToolExecutor(journal),owner=randomUUID();domain.source(id,{id:owner,kind:'user',body:'Synthetic lifecycle test, not a real owner fact.'});
 let executions=0;for(const [name,effect] of [['fixture-read','read'],['fixture-write','write'],['fixture-fail','read']])tools.register(name,{description:'Synthetic lifecycle adapter',effect,inputSchema:{type:'object',properties:{},required:[],additionalProperties:false},execute:async()=>{executions++;if(name==='fixture-fail')throw Error('SYNTHETIC_TOOL_FAILURE');return {items:[]};}});
 const agent={id,desired:()=>journal.get(id),session:{snapshotEvents:()=>[{type:'user/message',data:{id:owner,role:'user',content:[{type:'text',text:'Synthetic lifecycle test'}]}}]},factory:{journal,domain,tools,config:{},autonomy:{settings:()=>({quotaEnabled:false,budgetWindow:'utc-day',timeZoneOffsetMinutes:0,contactCooldownMs:0}),quiet:()=>false}}};
 const messages=[{role:'system',content:[{type:'text',text:'Synthetic routing contract.'}]},{role:'user',content:[{type:'text',text:JSON.stringify({persona:domain.persona(id),input:[{id:owner,role:'user',content:[{type:'text',text:'Synthetic lifecycle test'}]}]})}]}];
 const usage={inputTokens:11,outputTokens:2,totalTokens:13},ids=[];
 const generated=(text,withUsage=true)=>{const rid=journal.reserve(id,100,Infinity,{turn:1,epoch:1,request:{lane:'foreground',budgetClass:'foreground',admittedIds:[owner]}});ids.push(rid);journal.dispatchAttempt(rid,{provider:'synthetic',model:'synthetic'});journal.settle(rid,withUsage?13:undefined);journal.endAttempt(rid,{state:'generated',usage:withUsage?usage:undefined,usageConfidence:withUsage?'reported':'unknown',textChars:text.length});return {rid,text,usage:withUsage?usage:undefined,reasoningChars:0};};
 const dialogue=(sequence,{signal=new AbortController().signal,withUsage=true,afterRequest}={})=>capabilityDialogue(agent,signal,{turn:1,epoch:1,admittedIds:[owner],messages,request:async()=>{const response=generated(sequence.shift(),withUsage);afterRequest?.();return response;}});
 const reopen=()=>{journal.close();journal=new ControlJournal(file);return journal;},row=rid=>({...journal.db.prepare('SELECT * FROM attempt WHERE id=?').get(rid)});
 return {id,owner,usage,ids,agent,tools,dialogue,generated,reopen,row,get journal(){return journal;},get executions(){return executions;}};
}
const call=tool=>JSON.stringify({capability:{tool,input:{}}});
for(const revokeAt of ['prepare','ticket'])await test('Revoked review material cannot reach a provider after awaiting '+revokeAt,async f=>{
 const {agent,journal}=f;let allowed=true,streams=0;
 const config={provider:'fixture',model:'fixture'};
 Object.assign(agent.factory,{config,tickets:new Map(),allowCall:async()=>{if(revokeAt==='ticket')allowed=false;}});
 agent.factory.autonomy.budget=()=>({tokenLimit:null,now:Date.now()});
 agent.ctx={llm:{prepareCall:async()=>{
   if(revokeAt==='prepare')allowed=false;
   return {config,async *stream(){streams++;yield {type:'finish',reason:{kind:'stop'}};}};
 }}};
 const assertMaterialsCurrent=()=>{if(!allowed)throw Object.assign(new Error('LEARNING_PACK_UNAVAILABLE'),{foregroundMaterialsChanged:true});};
 await assert.rejects(modelRequest(agent,new AbortController().signal,{turn:1,epoch:1,lane:'foreground',purpose:'conversation-review',messages:[{role:'user',content:[{type:'text',text:'synthetic draft'}]}],assertMaterialsCurrent}),/LEARNING_PACK_UNAVAILABLE/);
 assert.equal(streams,0);assert.equal(journal.get(f.id).used,0);assert.equal(journal.value(f.id,'modelFailures',{}).foreground,undefined);
});
await test('legacy foreground remains available after an empty response and accepts a terminal-only reply to the next input',async f=>{
 const {agent,journal,id}=f,events=[],queue=[];
 const message=()=>({id:randomUUID(),role:'user',content:[{type:'text',text:'本轮测试输入'}]});
 journal.put(id,'remaining',null);
 journal.put(id,'humanExecution',{conversation:{enabled:false}});
 Object.assign(agent.factory,{config:{provider:'fixture',model:'fixture'},management:{assertReasoningEffort(){}},allowCall:async()=>{}});
 agent.factory.autonomy.persona=()=>agent.factory.domain.persona(id);
 agent.session={id,snapshotEvents:()=>events,append:(type,data)=>events.push({seq:events.length+1,type,data,time:Date.now()})};
 agent.inbox={nextTurn:queue,nextStep:[],splice:(_target,start,count,inserted)=>queue.splice(start,count,...inserted)};
 agent.events={emit(){}};
 agent.flush=async()=>{};
 let frames=[],requests=0;
 agent.ctx={sessionProjections:{stateOf:()=>({lastTurn:requests})},llm:{prepareCall:async()=>({
   config:agent.factory.config,
   async *stream(){requests++;yield* frames;yield {type:'finish',reason:{kind:'stop'}};}
 })}};
 const first=message();
 queue.push(first);
 await HumanAgent.prototype.drive.call(agent,new AbortController().signal);
 assert.equal(journal.get(id).desired,'running');
 assert.equal(queue.length,0);
 const failed=journal.db.prepare("SELECT request,error FROM attempt WHERE state='failed'").get();
 assert.equal(failed.error,'EMPTY_MODEL_OUTPUT');
 assert.deepEqual(JSON.parse(failed.request).admittedIds,[first.id]);
 const second=message();
 queue.push(second);
 frames=[{type:'block-end',index:0,block:{type:'text',text:'只回复这一次。'}}];
 await HumanAgent.prototype.drive.call(agent,new AbortController().signal);
 assert.equal(requests,2);
 assert.equal(journal.get(id).desired,'running');
 assert.deepEqual(events.filter(e=>e.type==='assistant/message').map(e=>e.data.message.content[0].text),['只回复这一次。']);
 assert.equal(journal.db.prepare("SELECT count(*) n FROM attempt WHERE state='failed'").get().n,1);
});
await test('Reconciliation consumes the suffix across restart and commits the cursor with the outbox',async f=>{
 const events=[],reads=[],session={id:f.id,get seq(){return events.length;},snapshotEvents(from,to){reads.push([from,to]);return events.slice(from,to);}};
 const user=id=>({id,role:'user',content:[{type:'text',text:id}]});
 const append=(type,data)=>events.push({type,data,time:1000+events.length,seq:events.length});
 const splice=(start,removedCount,inserted)=>append('agent/inbox/spliced',{target:'next-turn',start,removedCount,inserted});
 for(let n=0;n<2000;n++)append('assistant/message',{message:{id:'reply-'+n,content:[{type:'text',text:'reply '+n}]}});
 splice(0,0,[user('pending')]);f.journal.reconcile(session);assert.deepEqual(reads,[[0,2001]]);
 f.reopen();reads.length=0;splice(1,0,[user('removed')]);splice(0,2,[user('new')]);
 append('assistant/message',{message:{id:'one-more',content:[{type:'text',text:'one more'}]}});
 f.journal.db.exec("CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END");
 assert.throws(()=>f.journal.reconcile(session),/fixture/);
 assert.equal(f.journal.value(f.id,'outboxProjection').offset,2001);
 f.journal.db.exec('DROP TRIGGER fail_insert');reads.length=0;f.journal.reconcile(session);
 assert.deepEqual(reads,[[2000,2001],[2001,2004]]);
 assert.equal(f.journal.value(f.id,'successes'),2001);assert.equal(f.journal.value(f.id,'memory'),'one more');
 assert.deepEqual(f.journal.db.prepare("SELECT text FROM outbox WHERE kind='user' ORDER BY seq").all().map(r=>r.text),['pending','new']);
 reads.length=0;f.journal.reconcile(session);assert.deepEqual(reads,[[2003,2004]]);
 assert.equal(f.journal.db.prepare('SELECT count(*) n FROM outbox').get().n,2003);
 events.splice(1999);reads.length=0;f.journal.reconcile(session);
 assert.deepEqual(reads,[[0,1999]]);assert.equal(f.journal.value(f.id,'successes'),1999);
});
await test('Only durable owner responses settle retry eligibility including local replies and upgraded receipts',async f=>{
 const add=(rid,ids,purpose,state)=>{
  f.journal.beginAttempt(f.id,rid,1,1,{lane:'foreground',admittedIds:ids,...(purpose?{purpose}:{})});
  f.journal.endAttempt(rid,{state});
 };
 const ids=()=>f.journal.retryInputIds(f.id,()=>true);
 add('retry-original',['batch-a','batch-b'],null,'failed');
 add('review-only',['batch-a','batch-b','review-only'],'conversation-review','failed');
 add('tool-complete',['batch-a','batch-b'],null,'completed');
 assert.deepEqual(ids(),['batch-a','batch-b']);
 f.journal.stageResponse(f.id,'final-local',1,1,'MESSAGE',{data:{message:{id:'assistant-local'}},ownerBatch:{id:'batch',inputIds:['batch-a']}});
 f.journal.commitResponse('final-local');assert.deepEqual(ids(),['batch-b']);
 add('final-wait',['batch-b'],null,'generated');f.journal.stageResponse(f.id,'final-wait',1,1,'WAIT',{});
 f.journal.commitResponse('final-wait');f.reopen();assert.deepEqual(ids(),[]);
 // Force an upgrade from just the old durable rows, with no new receipt keys.
 f.journal.db.exec("DELETE FROM metadata WHERE key GLOB 'owner-replied:*' OR key='ownerReplyReceiptBackfill'");
 f.journal.put(f.id,'local-admitted:pre-origin',['legacy-command']);
 f.journal.publish(f.id,'Legacy command response','assistant','assistant:pre-origin');
 add('old-failed',['legacy-command'],null,'failed');f.reopen();assert.deepEqual(ids(),[]);
 assert.equal(f.journal.value(f.id,'owner-replied:legacy-command'),true);
});
await test('Background review failure is not presented as a missing owner reply',async f=>{
 const events=[{seq:1,time:Date.now(),type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'HUMAN_REVIEW_ERROR',message:'INVALID_MEMORY_SUMMARY'}}}}];
 const session={id:f.id,snapshotEvents:()=>events};f.journal.reconcile(session);f.journal.reconcile(session);
 const rows=f.journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND kind='status'").all(f.id);
 assert.equal(rows.length,1);assert.match(rows[0].text,/后台记忆与人格回顾/);assert.doesNotMatch(rows[0].text,/未投递回复/);
 events.push({seq:2,time:Date.now(),type:'turn/end',data:{turn:2,reason:{kind:'error',error:{code:'HUMAN_DRIVER_ERROR',message:'MODEL_EXECUTION_FAILED'}}}});
 f.journal.reconcile(session);assert.match(f.journal.db.prepare("SELECT text FROM outbox WHERE agent=? ORDER BY seq DESC LIMIT 1").get(f.id).text,/未投递回复/);
});
await test('Consumed read survives real SQLite close/reopen; uncommitted natural reply remains interruptible',async f=>{const r=await f.dialogue([call('fixture-read'),'Natural result.']),before=f.row(f.ids[0]),used=f.journal.get(f.id).used;assert.equal(before.state,'completed');assert.equal(f.row(r.rid).state,'generated');f.reopen().recoverAttempts(f.id);assert.deepEqual(f.row(f.ids[0]),before);assert.equal(f.row(r.rid).state,'interrupted');assert.equal(f.journal.get(f.id).used,used);assert.equal(f.executions,1);});
await test('Rejected protocol remains rejected after cold reopen and is not executed',async f=>{await f.dialogue(['```json\n'+call('fixture-read')+'\n```',call('fixture-read'),'Done.']);const a=f.row(f.ids[0]);assert.equal(a.state,'validation-rejected');assert.equal(a.error,'INVALID_CAPABILITY_REQUEST');f.reopen().recoverAttempts(f.id);assert.deepEqual(f.row(f.ids[0]),a);assert.equal(f.executions,1);});
await test('Completed model routing does not disguise a failed tool job',async f=>{await f.dialogue([call('fixture-fail'),'No result.']);assert.equal(f.row(f.ids[0]).state,'completed');assert.equal(f.tools.list(f.id).items[0].status,'failed');f.reopen().recoverAttempts(f.id);assert.equal(f.row(f.ids[0]).state,'completed');assert.equal(f.journal.db.prepare('SELECT status FROM human_tool_job').get().status,'failed');});
await test('Write approval remains pending across reopen without executing the action',async f=>{await f.dialogue([call('fixture-write')]);assert.equal(f.row(f.ids[0]).state,'completed');assert.equal(f.executions,0);f.reopen().recoverAttempts(f.id);assert.equal(f.journal.db.prepare('SELECT status FROM human_tool_job').get().status,'awaiting-approval');assert.equal(f.journal.db.prepare('SELECT count(*) n FROM response_stage').get().n,0);assert.equal(f.executions,0);});
await test('A staged final reply recovers once, separately from consumed routing output',async f=>{const r=await f.dialogue([call('fixture-read'),'Natural result.']),message={id:randomUUID(),role:'assistant',content:[{type:'text',text:r.text}]},events=[{seq:1,type:'turn/start',data:{turn:1}}],session={id:f.id,snapshotEvents:()=>events,append:(type,data)=>events.push({seq:events.length+1,type,data,time:Date.now()})};f.journal.stageResponse(f.id,r.rid,1,1,'MESSAGE',{data:{message},usage:f.usage,textChars:r.text.length});f.reopen();const recovered=f.journal.recoverResponses(session);for(const id of recovered)f.journal.commitResponse(id);f.journal.recoverAttempts(f.id);assert.equal(f.row(r.rid).state,'completed');assert.equal(f.row(f.ids[0]).state,'completed');assert.equal(events.filter(e=>e.type==='assistant/message').length,1);assert.deepEqual(f.journal.recoverResponses(session),[]);assert.equal(events.filter(e=>e.type==='assistant/message').length,1);});
await test('Review outage preserves one canonical reply and one notification through restart and remote delivery',async f=>{
 f.agent.factory.conversationReview=true;f.agent.factory.relationship={settings:()=>({enabled:false})};f.agent.factory.dialogueState={context:()=>null};
 const r=await choiceDialogueRequest(async(_a,_s,o)=>{
  if(o.purpose==='conversation-review'){
   f.journal.beginAttempt(f.id,'review-fixture',o.turn,o.epoch,o);
   f.journal.endAttempt('review-fixture',{state:'failed',error:'MODEL_EXECUTION_FAILED'});
   throw Object.assign(Error('MODEL_EXECUTION_FAILED'),{attemptId:'review-fixture'});
  }
  return f.generated('原回复仍然连贯。');
 })(f.agent,new AbortController().signal,{epoch:1,turn:1,lane:'foreground',admittedIds:[f.owner],messages:[{role:'system',content:[{type:'text',text:'Synthetic'}]},{role:'user',content:[{type:'text',text:JSON.stringify({persona:f.agent.factory.domain.persona(f.id),input:[]})}]}]});
 assert.equal(r.dialogueQuality.status,'review-unavailable');const message={id:randomUUID(),role:'assistant',content:[{type:'text',text:r.text}]},events=[{seq:1,type:'turn/start',data:{turn:1}}],session={id:f.id,snapshotEvents:()=>events,append:(type,data)=>events.push({seq:events.length+1,type,data,time:Date.now()})};
 f.journal.stageResponse(f.id,r.rid,1,1,'MESSAGE',{data:{message},usage:f.usage,textChars:r.text.length});f.reopen();
 assert(f.journal.value(f.id,'conversationReviewCooldown').until>Date.now());
 for(const rid of f.journal.recoverResponses(session))f.journal.commitResponse(rid);f.journal.reconcile(session);f.journal.reconcile(session);
 assert.deepEqual(f.journal.retryInputIds(f.id,()=>true),[]);
 const feed=()=>f.journal.db.prepare('SELECT * FROM outbox WHERE agent=? ORDER BY seq').all(f.id);assert.equal(feed().filter(r=>r.kind==='assistant').length,1);assert.equal(feed().filter(r=>r.kind==='model-error').length,1);assert.equal(feed().filter(r=>r.kind==='status').length,0);assert.equal(f.row(r.rid).state,'completed');assert.equal(f.journal.value(f.id,'lastError',null),null);
 const received=[],remote=new RemoteGateway(':memory:',{state:async()=>({sessionId:f.id,desired:'running',inbox:0,messages:[]}),events:async after=>({sessionId:f.id,events:feed().filter(row=>row.seq>after)})},{seal:x=>x,unseal:x=>x});
 try{remote.register('fixture',{verify:async()=>({privateOwner:true}),send:async(_c,text)=>{received.push(text);return {accepted:true};}});remote.db.prepare('INSERT INTO channel VALUES(?,?,?,1,?,0,NULL)').run('fixture','fixture',JSON.stringify({ownerId:'owner'}),f.id);await remote.tick();await remote.tick();assert.equal(received.length,2);assert(received.some(t=>t.includes('原回复仍然连贯。')));assert(received.some(t=>t.includes('基础校验')));}finally{await remote.close();}
});
await test('A stale staged final reply is discarded rather than silently published',async f=>{const r=await f.dialogue([call('fixture-read'),'Natural result.']);f.journal.stageResponse(f.id,r.rid,1,1,'MESSAGE',{data:{message:{id:randomUUID(),content:[{type:'text',text:r.text}]}},usage:f.usage});f.journal.set(f.id,'paused');f.reopen();let published=0;f.journal.recoverResponses({id:f.id,snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}],append:()=>published++});assert.equal(published,0);assert.equal(f.row(r.rid).error,'STALE_STAGED_RESULT');assert.equal(f.row(f.ids[0]).state,'completed');});
await test('Unknown consumed usage remains unknown and conservatively reserved after recovery',async f=>{await f.dialogue([call('fixture-read'),'Done.'],{withUsage:false});const before=f.row(f.ids[0]),used=f.journal.get(f.id).used;assert.equal(before.usage_confidence,'unknown');assert.equal(used,200);f.reopen().recoverAttempts(f.id);assert.deepEqual(f.row(f.ids[0]),before);assert.equal(f.journal.get(f.id).used,used);});
await test('Real unfinished dispatch is still recovered as interrupted with unknown usage',async f=>{const rid=f.journal.reserve(f.id,100,Infinity,{turn:1,epoch:1,request:{lane:'foreground'}});f.journal.dispatchAttempt(rid,{provider:'synthetic',model:'synthetic'});f.reopen().recoverAttempts(f.id);assert.equal(f.row(rid).state,'interrupted');assert.equal(f.row(rid).error,'PROCESS_INTERRUPTED');assert.equal(f.row(rid).usage_confidence,'unknown');});
await test('Undispatched preparation is released and not counted as model consumption',async f=>{const rid=f.journal.reserve(f.id,100,Infinity,{turn:1,epoch:1,request:{lane:'foreground'}});f.reopen().recoverAttempts(f.id);assert.equal(f.row(rid).state,'interrupted');assert.equal(f.row(rid).usage_confidence,'not-dispatched');assert.equal(f.journal.get(f.id).used,0);});
await test('Cancellation before consumption does not dispatch a tool or falsely complete its routing',async f=>{const controller=new AbortController();await assert.rejects(f.dialogue([call('fixture-read')],{signal:controller.signal,afterRequest:()=>controller.abort()}));assert.equal(f.executions,0);assert.equal(f.row(f.ids[0]).state,'generated');f.reopen().recoverAttempts(f.id);assert.equal(f.row(f.ids[0]).state,'interrupted');});
const statistics=f=>{f.journal.db.prepare('UPDATE attempt SET started=? WHERE agent=?').run(Date.now()-100,f.id);return usageStatistics({...f.agent.factory,journal:f.journal},f.id);};
await test('Consumed routing remains one foreground request with identical usage and no false failure after restart',async f=>{await f.dialogue([call('fixture-write')]);const before=statistics(f);assert.equal(before.overall.requests,1);assert.equal(before.overall.reportedTokens,13);assert.equal(before.overall.failedRequests,0);f.reopen().recoverAttempts(f.id);const after=statistics(f);assert.equal(after.overall.requests,1);assert.equal(after.overall.reportedTokens,13);assert.equal(after.overall.failedRequests,0);assert.equal(after.overall.foregroundRequests,1);assert.equal(after.currentQuota.available,false);});
await test('Unknown consumed usage stays unknown in actual statistics, never zero-cost success',async f=>{await f.dialogue([call('fixture-write')],{withUsage:false});f.reopen().recoverAttempts(f.id);const s=statistics(f);assert.equal(s.overall.requests,1);assert.equal(s.overall.unknownUsageRequests,1);assert.equal(s.overall.actualTokens,null);assert.equal(s.overall.conservativeTokens,100);});
await test('Protocol rejection remains visible in failed classification without counting it as a tool dispatch',async f=>{await f.dialogue(['```json\n'+call('fixture-write')+'\n```',call('fixture-write')]);f.reopen().recoverAttempts(f.id);const s=statistics(f);assert.equal(s.overall.requests,2);assert.equal(s.overall.reportedTokens,26);assert.equal(s.overall.failedRequests,1);assert.equal(f.executions,0);});
const result={at:new Date().toISOString(),passed:tests.filter(x=>x.passed).length,failed:tests.filter(x=>!x.passed).length,tests,scope:'Maintained source with real ControlJournal SQLite close/reopen, synthetic model responses and tools; no production access or model calls.'};if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
