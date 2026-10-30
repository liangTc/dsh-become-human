// Real OS termination at deterministic barriers. All records, providers and
// native sessions belong to a newly created disposable test directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR;
const hook=anchor?registerHooks({resolve(name,context,next){try{return next(name,context);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.startsWith('/')||name.includes(':'))throw error;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}}):null;
const {ControlJournal,HumanFactory}=await import('../plugins/become-human/driver.mjs');
const {DomainMemory}=await import('../plugins/become-human/domain.mjs');
const {HumanManagement}=await import('../plugins/become-human/management.mjs');
const {GoalEngine}=await import('../plugins/become-human/goals.mjs');
const {DeletionLab}=await import('../plugins/become-human/deletion.mjs');
const {ActionStore}=await import('../plugins/become-human/actions.mjs');
const {ToolExecutor}=await import('../plugins/become-human/tool-executor.mjs');
const {SafetyLedger,GuardedJsonl}=await import('../plugins/become-human/safety.mjs');
const {SessionRetirement}=await import('../plugins/become-human/retirement.mjs');
const {actionPaths}=await import('../plugins/become-human/actions-files.mjs');
const {Context}=await import('@deepseek-ai/cordis');
const {default:Agents}=await import('@deepseek-ai/dsh-agent');
const {default:Sessions,Session}=await import('@deepseek-ai/dsh-session');
const {default:Projections}=await import('@deepseek-ai/dsh-session-projection');
const {default:Jsonl}=await import('@deepseek-ai/dsh-session-persistence-jsonl');
const {default:Llm,LlmAdapter}=await import('@deepseek-ai/dsh-llm');
const self=fileURLToPath(import.meta.url),[mode,suite,phase,dir]=process.argv.slice(2);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function owned(root){assert.equal((await readJson(path.join(root,'fixture.json'))).scope,'process-crash-fixture');assert.equal(await fs.realpath(root),path.resolve(root));}
function barrier(root,label){writeFileSync(path.join(root,'barrier.json'),JSON.stringify({label,pid:process.pid,at:new Date().toISOString()}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
function base(root){const journal=new ControlJournal(path.join(root,'journal.sqlite')),id='431cfc92-79f4-425b-81b0-f439531bab4b';journal.ensure(id);journal.db.exec('CREATE TABLE IF NOT EXISTS learning_note(id TEXT PRIMARY KEY,agent TEXT,memory_id TEXT,source_id TEXT,data TEXT,status TEXT,created INTEGER,feedback TEXT)');const domain=new DomainMemory(journal),autonomy={settings:()=>({enabled:true,researchEnabled:true,learningEnabled:true,sources:[]})},goals=new GoalEngine(journal,domain,autonomy),management=new HumanManagement({journal,domain,goals,autonomy});return {journal,id,domain,goals,management};}
async function goalWorker(recover){
 const f=base(dir);try{
  if(!recover){const request={op:'goal-propose',requestId:randomUUID(),description:'Synthetic process crash goal',expires:Date.now()+86400000,milestones:[{kind:'research',question:'How does a synthetic retry preserve goal identity?'}]};await fs.writeFile(path.join(dir,'request.json'),JSON.stringify(request));if(phase==='before-commit'){const original=f.goals.propose.bind(f.goals);f.goals.propose=(...args)=>{const result=original(...args);barrier(dir,phase);return result;};}const result=await f.management.mutate(f.id,request);await fs.writeFile(path.join(dir,'created.json'),JSON.stringify(result));barrier(dir,'after-commit');}
  const request=await readJson(path.join(dir,'request.json')),before=f.journal.db.prepare('SELECT count(*) n FROM goal_record').get().n;assert.equal(before,phase==='before-commit'?0:1);const rows=await Promise.all(Array.from({length:8},()=>f.management.mutate(f.id,request)));assert.equal(new Set(rows.map(r=>r.id)).size,1);for(const table of ['goal_record','source_record','human_goal_request'])assert.equal(f.journal.db.prepare('SELECT count(*) n FROM '+table).get().n,1);if(phase==='after-commit')assert.equal(rows[0].id,(await readJson(path.join(dir,'created.json'))).id);return {rolledBack:phase==='before-commit',replays:8,goals:1,sources:1,requestKeys:1};
 }finally{f.journal.close();}
}
async function responseHarness(root,checkpoint,wait){
 const ctx=new Context(),fibers=[];let calls=0;
 for(const plugin of [Sessions,Agents,Projections])fibers.push(await ctx.plugin(plugin));
 fibers.push(await ctx.plugin(Jsonl,{root:path.join(root,'native'),compression:'none'}));fibers.push(await ctx.plugin(Llm));
 class Adapter extends LlmAdapter{async *stream(){calls++;yield {type:'text-delta',index:0,text:wait?'[WAIT]':'SYNTHETIC_CRASH_REPLY'};yield {type:'usage',usage:{inputTokens:20,outputTokens:4,totalTokens:24}};yield {type:'finish',reason:{kind:'stop'}};}}
 const unregister=ctx.llm.registerAdapter(['synthetic-process-crash'],new Adapter());fibers.push(await ctx.plugin(HumanFactory,{journal:path.join(root,'journal.sqlite'),provider:'synthetic-process-crash',model:'fixture',tokenBudget:20000,intervalMs:15000,maxCycles:1,maxTokens:512,responseCheckpoint:checkpoint}));
 return {ctx,get journal(){return ctx.becomeHuman.journal;},get calls(){return calls;},async close(){for(const fiber of fibers.reverse())await fiber.dispose();unregister();}};
}
async function responseWorker(recover){
 const wait=phase.startsWith('wait-'),stale=phase.startsWith('stale-'),point=phase.replace(/^(wait-|stale-)/u,'');let h;
 h=await responseHarness(dir,async(label,a)=>{if(label===point){if(stale)h.journal.set(a.id,'paused');barrier(dir,phase);}},wait);
 if(!recover){const handle=await h.ctx.agents.create({sessionId:'synthetic-crash-session'}),a=handle.agent;a.send({id:'synthetic-input',role:'user',source:{kind:'process-crash-fixture'},content:[{type:'text',text:'A disposable crash fixture, not a real owner fact.'}]},'next-turn',false);await a.flush();a.requestedCycles=1;a.wake=true;await a.control('running');await delay(12000);await a.whenIdle();throw Error('RESPONSE_BARRIER_NOT_REACHED:'+JSON.stringify({desired:a.desired(),lastError:a.lastError,attempts:h.journal.db.prepare('SELECT state,error FROM attempt').all()}));}
 const handle=await h.ctx.agents.resume({resumeSessionId:'synthetic-crash-session'}),a=handle.agent,events=a.session.snapshotEvents(),count=events.filter(e=>e.type==='assistant/message').length;
 assert.equal(h.calls,0);assert.equal(a.desired().desired,'paused');assert.equal(count,wait||stale?0:1);assert.equal(events.filter(e=>e.type==='turn/start').length,events.filter(e=>e.type==='turn/end').length);const stage=h.journal.db.prepare('SELECT * FROM response_stage').get(),attempt=h.journal.db.prepare('SELECT * FROM attempt').get();assert.equal(stage.state,stale?'discarded':'committed');assert.equal(stage.payload,'null');assert.equal(attempt.state,stale?'interrupted':wait?'wait':'completed');assert.equal(h.journal.db.prepare('SELECT count(*) n FROM outbox WHERE kind=?').get(wait?'wait':'assistant').n,stale?0:1);await handle.dispose();await h.close();
 const again=await responseHarness(dir,undefined,wait),second=await again.ctx.agents.resume({resumeSessionId:'synthetic-crash-session'});assert.equal(second.agent.session.snapshotEvents().filter(e=>e.type==='assistant/message').length,count);assert.equal(again.calls,0);await second.dispose();await again.close();return {nativeReplies:count,providerCallsOnRecovery:0,repeatedRecoveryNoDuplicates:true,stagedBodyRemoved:true,staleFenced:stale,wait};
}
async function deleteWorker(recover){
 const journal=new ControlJournal(path.join(dir,'journal.sqlite')),lab=await new DeletionLab(path.join(dir,'lab'),journal).init();try{
  if(!recover){const preview=await lab.create();await fs.writeFile(path.join(dir,'created.json'),JSON.stringify({id:preview.id}));await lab.request({...preview,confirmation:'删除临时会话'},async label=>{if(label===phase)barrier(dir,label);});throw Error('DELETE_BARRIER_NOT_REACHED');}
  const {id}=await readJson(path.join(dir,'created.json'));assert.equal(lab.status().retirements[0].phase,'DONE');await assert.rejects(lab.read(id),/SESSION_RETIRED/);assert.equal((await lab.inventory(id)).length,0);for(const table of ['metadata','outbox','user_request','attempt','response_stage','reservation','audit'])assert.equal(journal.db.prepare('SELECT count(*) n FROM '+table+' WHERE agent=?').get(id).n,0);await lab.recover();return {retirement:'DONE',readFenced:true,ownedBodies:0,repeatedRecoverySafe:true};
 }finally{await lab.close();journal.close();}
}
async function actionFixture(root){
 const f=base(root);f.journal.safety=await SafetyLedger.open(path.join(root,'safety'));
 const validNote=(agent,id)=>{const row=f.journal.db.prepare('SELECT * FROM learning_note WHERE agent=? AND id=?').get(agent,id);return row?{...row,data:JSON.parse(row.data)}:null;},actions=new ActionStore(f.journal,f.domain,{root:path.join(root,'artifacts'),validNote});return {...f,actions,close(){f.journal.safety.close();f.journal.close();}};
}
async function actionWorker(recover){
 const f=await actionFixture(dir);try{
  if(!recover){const noteId=randomUUID(),sourceId=randomUUID(),claim='The open attribute is a boolean attribute.';f.domain.source(f.id,{id:sourceId,kind:'imported',body:JSON.stringify({url:'https://example.com/details',excerpt:claim})});const memoryId=f.domain.save(f.id,{type:'skill',truth:'inferred',refs:[sourceId],payload:{title:'Boolean attribute',summary:claim}});f.journal.db.prepare("INSERT INTO learning_note VALUES(?,?,?,?,?,'active',?,NULL)").run(noteId,f.id,memoryId,sourceId,JSON.stringify({title:'Boolean attribute',summary:claim,claims:[{text:claim,quote:claim}],source:{url:'https://example.com/details',digest:'a'.repeat(64),fetchedAt:Date.now(),partial:true}}),Date.now());let action=f.actions.proposeReport(f.id,{requestId:randomUUID(),title:'Synthetic crash report',noteIds:[noteId]});action=f.actions.approve(f.id,action.id,{expectedVersion:action.version,digest:action.digest});await f.actions.anchor(f.id);await fs.writeFile(path.join(dir,'created.json'),JSON.stringify(action));
   const originalUpdate=f.actions.update.bind(f.actions),originalAnchor=f.actions.anchor.bind(f.actions),originalComplete=f.actions.complete.bind(f.actions),paths=actionPaths(f.actions.root,f.id,action.id);
   f.actions.update=(row,status,...args)=>{const result=originalUpdate(row,status,...args);if(phase==='inside-intent'&&status==='executing')barrier(dir,phase);return result;};
   f.actions.anchor=async agent=>{await originalAnchor(agent);const started=f.journal.safety.rows.some(r=>r.id==='human-action-started:'+action.id);if(phase==='after-intent'&&started&&!existsSync(paths.stage)&&!existsSync(paths.path))barrier(dir,phase);if(phase==='after-stage'&&existsSync(paths.stage)&&!existsSync(paths.path))barrier(dir,phase);};
   f.actions.complete=(row,options)=>{if(phase==='after-publish')barrier(dir,phase);const result=originalComplete(row,options);if(phase==='after-receipt')barrier(dir,phase);return result;};await f.actions.execute(f.id,action.id,{valid:()=>true});throw Error('ACTION_BARRIER_NOT_REACHED');
  }
  const created=await readJson(path.join(dir,'created.json')),before=f.actions.get(f.id,created.id),published=existsSync(created.path),beforeMtime=published?(await fs.stat(created.path)).mtimeMs:null;await f.actions.recover(f.id,{valid:()=>true});let action=f.actions.get(f.id,created.id);assert.equal(action.status,phase==='inside-intent'?'approved':'completed');
  // A kill within the SQLite intent transaction rolls the entire transaction
  // back. Approval survives and requires an explicit queue execution.
  if(phase==='inside-intent'){assert.equal(published,false);await f.actions.execute(f.id,created.id,{valid:()=>true});action=f.actions.get(f.id,created.id);}
  assert.equal(action.status,'completed');assert.equal(f.actions.verifyReceipt(f.id,action.id),true);assert.equal(action.digest,created.digest);assert.equal((await fs.readFile(action.path,'utf8')),created.content);const receipt=JSON.stringify(action.receipt);await f.actions.recover(f.id,{valid:()=>true});assert.equal(JSON.stringify(f.actions.get(f.id,created.id).receipt),receipt);if(published)assert.equal((await fs.stat(action.path)).mtimeMs,beforeMtime);assert.equal(f.journal.safety.rows.filter(r=>r.id==='human-action-completed:'+action.id).length,1);return {beforeStatus:before.status,afterStatus:action.status,matchingDigest:true,repeatedRecoveryStable:true,publishedFileNotRewritten:published?true:null,signedCompletionRecords:1};
 }finally{f.close();}
}
async function exportWorker(recover){
 const ctx=new Context(),fiber=await ctx.plugin(GuardedJsonl,{root:path.join(dir,'native'),safetyRoot:path.join(dir,'safety'),compression:'none'});await ctx.sessionPersistence.ready;
 const storage=ctx.sessionPersistence,journal=new ControlJournal(path.join(dir,'journal.sqlite')),domain=new DomainMemory(journal),id='4a19dfb2-be97-4997-a55d-07f6aa82ce63',dataRoot=path.join(dir,'data');await fs.mkdir(dataRoot,{recursive:true});journal.safety=storage.ledger;const retirement=new SessionRetirement(storage,journal,domain,{dataRoot});
 try{
  if(!recover){journal.ensure(id);await storage.ledger.configureBudget('synthetic-window',10000,37);const session=Session.create(id);session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'process-crash-fixture'},content:[{type:'text',text:'SYNTHETIC_EXPORT_BODY'}]},{surfaceOp:'append'});const writer=await storage.create(session.header);await writer.append(session.snapshotEvents());await writer.flush();await writer.close();await fs.writeFile(path.join(dir,'unrelated.txt'),'KEEP_UNRELATED');
   const originalPrepare=journal.db.prepare.bind(journal.db),originalGuard=storage.guard.bind(storage);
   if(phase==='after-register')journal.db.prepare=(sql)=>{const statement=originalPrepare(sql);if(sql==='INSERT INTO owned_artifact VALUES(?,?,?)')return {run(...args){const result=statement.run(...args);barrier(dir,phase);return result;}};return statement;};
   if(phase==='after-write')storage.guard=agent=>{originalGuard(agent);const artifact=journal.db.prepare("SELECT path FROM owned_artifact WHERE agent=? AND kind='export'").get(agent);if(artifact&&existsSync(artifact.path))barrier(dir,phase);};
   await retirement.export(id);throw Error('EXPORT_BARRIER_NOT_REACHED');
  }
  const paths=journal.db.prepare('SELECT path FROM owned_artifact WHERE agent=?').all(id).map(row=>row.path);assert.equal(paths.length,1);assert.equal(existsSync(paths[0]),phase==='after-write');const preview=await retirement.preview(id),requestId=randomUUID();await retirement.request({id,token:preview.token,confirmation:'删除当前会话',requestId});await retirement.jobs.get(requestId).promise;assert.equal(retirement.status(requestId).phase,'completed');await assert.rejects(storage.open(id,'read'),/SESSION_RETIRED/);for(const file of paths)assert.equal(existsSync(file),false);assert.equal(journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(id).n,0);assert.equal(await fs.readFile(path.join(dir,'unrelated.txt'),'utf8'),'KEEP_UNRELATED');assert.equal(storage.ledger.used(),37);await retirement.recover();return {exportReached:phase,registeredArtifactsCleaned:true,retirement:'completed',nativeReadFenced:true,budgetPreserved:37,unrelatedFilePreserved:true};
 }finally{await retirement.close();journal.close();await fiber.dispose();}
}
async function toolWorker(recover){
 const f=base(dir);f.journal.safety=await SafetyLedger.open(path.join(dir,'safety'));const tools=new ToolExecutor(f.journal),effectFile=path.join(dir,'effect.jsonl');
 tools.register('synthetic-owned-write',{description:'Append one line to this disposable fixture only',effect:'write',scope:'owned-test-file',inputSchema:{type:'object',properties:{marker:{type:'string',minLength:1,maxLength:80}},required:['marker'],additionalProperties:false},execute:async(input)=>{if(!recover&&phase==='after-dispatch')barrier(dir,phase);const handle=await fs.open(effectFile,'a');try{await handle.writeFile(input.marker+'\n');await handle.sync();}finally{await handle.close();}if(!recover&&phase==='after-effect')barrier(dir,phase);return {written:true};}});
 try{
  if(!recover){const request={tool:'synthetic-owned-write',input:{marker:'SYNTHETIC_EFFECT_'+randomUUID()},requestId:randomUUID()};let job=tools.submit(f.id,request);job=await tools.approve(f.id,job.id,{expectedVersion:job.version,digest:job.digest});await fs.writeFile(path.join(dir,'created.json'),JSON.stringify({request,job}));if(phase==='approved-queued')barrier(dir,phase);await tools.execute(f.id,job.id,{signal:new AbortController().signal,valid(){}});barrier(dir,'after-complete');}
  const {request,job}=await readJson(path.join(dir,'created.json'));tools.recover(f.id);let current=tools.get(f.id,job.id),effect=await fs.readFile(effectFile,'utf8').catch(error=>error.code==='ENOENT'?'':Promise.reject(error));
  if(phase==='approved-queued'){assert.equal(current.status,'queued');assert.equal(effect,'');current=await tools.execute(f.id,job.id,{signal:new AbortController().signal,valid(){}});assert.equal(current.status,'completed');effect=await fs.readFile(effectFile,'utf8');}
  else{assert.equal(current.status,phase==='after-complete'?'completed':'unknown');assert.equal(effect,phase==='after-dispatch'?'':request.input.marker+'\n');assert.equal(tools.next(f.id),null);await assert.rejects(tools.execute(f.id,job.id,{signal:new AbortController().signal,valid(){}}),/TOOL_JOB_NOT_EXECUTABLE/);}
  const replay=tools.submit(f.id,request);assert.equal(replay.id,current.id);assert.equal(replay.status,current.status);tools.recover(f.id);assert.equal(tools.get(f.id,job.id).status,current.status);assert.equal(await fs.readFile(effectFile,'utf8').catch(error=>error.code==='ENOENT'?'':Promise.reject(error)),effect);return {status:current.status,effects:effect?1:0,requestReplaySameJob:true,recoveryDidNotReplayEffect:true,unknownNeverQueued:phase==='after-dispatch'||phase==='after-effect'?true:null};
 }finally{f.journal.safety.close();f.journal.close();}
}
if(mode==='crash'||mode==='recover'){
 await owned(dir);const workers={goal:goalWorker,response:responseWorker,delete:deleteWorker,action:actionWorker,export:exportWorker,tool:toolWorker};assert(workers[suite]);const result=await workers[suite](mode==='recover');console.log(JSON.stringify(result));process.exit(0);
}
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'bh-os-crash-')),cases=[];
function child(args){const child=spawn(process.execPath,[self,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr})));return {child,done,get output(){return {stdout,stderr};}};}
async function check(group,point){if(process.env.BH_TEST_GROUP&&process.env.BH_TEST_GROUP!==group||process.env.BH_TEST_CASE&&process.env.BH_TEST_CASE!==group+'-'+point)return;const local=path.join(root,group+'-'+point);await fs.mkdir(local);await fs.writeFile(path.join(local,'fixture.json'),JSON.stringify({scope:'process-crash-fixture'}));let running;try{running=child(['crash',group,point,local]);const until=Date.now()+40000;let reached;while(Date.now()<until){try{reached=await readJson(path.join(local,'barrier.json'));break;}catch(error){if(error.code!=='ENOENT')throw error;}if(running.child.exitCode!==null)throw Error('Child exited before barrier: '+JSON.stringify(await running.done));await delay(30);}assert(reached,'Crash barrier timed out: '+JSON.stringify(running.output));assert.equal(reached.pid,running.child.pid);assert.equal(reached.label,point);assert(running.child.kill('SIGKILL'));const killed=await running.done;assert(killed.code!==0||killed.signal,'Child was not force-terminated');const recovery=child(['recover',group,point,local]),timer=setTimeout(()=>recovery.child.kill('SIGKILL'),40000);let result;try{result=await recovery.done;}finally{clearTimeout(timer);}assert.equal(result.code,0,result.stderr||result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));cases.push({name:group+'-'+point,passed:true,termination:{pid:reached.pid,...killed,stdout:undefined,stderr:undefined},evidence});}catch(error){if(running?.child.exitCode===null)running.child.kill('SIGKILL');cases.push({name:group+'-'+point,passed:false,error:error.stack});}console.log(JSON.stringify(cases.at(-1)));}
for(const point of ['before-commit','after-commit'])await check('goal',point);
for(const point of ['after-stage','after-native','after-close','wait-after-stage','wait-after-native','wait-after-close','stale-after-stage'])await check('response',point);
for(const point of ['after-intent','during-purge','after-purge'])await check('delete',point);
for(const point of ['inside-intent','after-intent','after-stage','after-publish','after-receipt'])await check('action',point);
for(const point of ['after-register','after-write'])await check('export',point);
for(const point of ['approved-queued','after-dispatch','after-effect','after-complete'])await check('tool',point);
const result={at:new Date().toISOString(),root,scope:'Real OS child-process termination at deterministic test barriers; maintained source, real SQLite/native JSONL/files and signed DPAPI ledger, synthetic provider and records. No production ports, messages, credentials or model calls. No physical power-loss claim.',passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases};await fs.writeFile(process.env.BH_TEST_RESULT??path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,passed:result.passed,failed:result.failed}));hook?.deregister();if(result.failed)process.exitCode=1;
