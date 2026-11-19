import './test-dependencies.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const {ControlJournal}=await import('../plugins/become-human/driver.mjs');
await import('../plugins/become-human/index.mjs'); // Include the deployed entry's syntax and import graph.
import {RemoteGateway} from '../plugins/become-human-web/remote.mjs';
import {modelRequest} from '../plugins/become-human/model-gateway.mjs';
import {modelFailureDiagnostic,saveModelFailure,clearModelFailure,modelFailureNotification} from '../plugins/become-human/model-failure.mjs';
import {recordReviewUnavailable} from '../plugins/become-human/conversation-review-recovery.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'human-model-notice-'));
const id='fixture-session',channel='fixture-channel',journal=new ControlJournal(path.join(dir,'control.sqlite'));journal.ensure(id);
const state={sessionId:id,desired:'paused',stopReason:'error',inbox:0,messages:[],autonomy:{paused:true}};
const feed=()=>journal.db.prepare('SELECT * FROM outbox WHERE agent=? ORDER BY seq').all(id);
const runtime={state:async()=>state,events:async after=>({sessionId:id,events:feed().filter(row=>row.seq>after)})};
const received=[];let unknown=false;
function gateway(){const g=new RemoteGateway(path.join(dir,'remote.sqlite'),runtime,{seal:x=>x,unseal:x=>x});g.register('fixture',{verify:async()=>({privateOwner:true}),send:async(_cfg,text)=>{received.push(text);if(unknown)throw Error('DELIVERY_NOT_CONFIRMED');return {accepted:true};}});return g;}
let remote=gateway();
try{
 remote.db.prepare('INSERT INTO channel VALUES(?,?,?,1,?,0,NULL)').run(channel,'fixture',JSON.stringify({ownerId:'fixture-owner'}),id);
 remote.preference('reply-enabled',false); // A paused model must still report its failure.
 remote.queueDelivery(remote.channel(channel),{seq:0,kind:'assistant',text:'先等。再说。',presentation:{kind:'chat-bubbles',parts:['先等。','再说。'],gapMs:1000,ownerInputRevision:0,pauseRevision:0,autonomous:false}},state);
 const diagnostic=modelFailureDiagnostic({message:'Stream ended without finish_reason'});
 assert.equal(diagnostic.category,'incomplete-stream');
 const entry={at:Date.now(),attemptId:'review-call',lane:'foreground',purpose:'conversation-review',provider:'fixture',model:'fixture-model',code:'MODEL_EXECUTION_FAILED',...diagnostic};
 // Persisted old diagnostics are not backfilled by polling or installation.
 journal.put(id,'modelFailures',{selection:entry});await remote.tick();assert.equal(received.length,0);
 saveModelFailure(journal,id,entry);saveModelFailure(journal,id,entry);assert.equal(feed().length,1);
 assert.equal(feed()[0].kind,'model-error');assert.match(feed()[0].text,/回复检查/);assert.match(feed()[0].text,/尚未投递/);assert.match(feed()[0].text,/finish_reason/);
 await remote.tick();await remote.tick();assert.equal(received.length,1);assert.match(received[0],/^\[系统\]/);assert.equal(remote.db.prepare("SELECT state FROM delivery WHERE kind='model-error'").get().state,'sent');assert.equal(remote.db.prepare('SELECT state FROM delivery WHERE seq=0').get().state,'pending');
 await remote.close();remote=gateway();await remote.tick();assert.equal(received.length,1,'restart must not resend');
 // A new failure is still a new notification; a successful call cannot delete
 // the durable notice before the phone polls for it.
 saveModelFailure(journal,id,{...entry,attemptId:'selection-call',lane:'selection',purpose:null});clearModelFailure(journal,id,'selection');await remote.tick();assert.equal(received.length,2);assert.match(received[1],/自主选题/);
 unknown=true;saveModelFailure(journal,id,{...entry,attemptId:'unknown-call'});await remote.tick();assert.equal(received.length,3);assert.equal(remote.db.prepare("SELECT state FROM delivery ORDER BY seq DESC LIMIT 1").get().state,'unknown');
 await remote.close();remote=gateway();await remote.tick();assert.equal(received.length,3,'unknown receipt must not resend');unknown=false;
 const count=feed().length;
 for(const code of ['USER_PREEMPTED','USER_STOPPED','STALE_EPOCH','STALE_RESPONSE','ABORTED','AUTONOMOUS_BUDGET_EXHAUSTED'])saveModelFailure(journal,id,{...entry,attemptId:code,code});assert.equal(feed().length,count);
 saveModelFailure(journal,id,{...entry,attemptId:null,at:101});saveModelFailure(journal,id,{...entry,attemptId:null,at:101});assert.equal(feed().length,count+1,'preparation failure has a stable occurrence key');
 const secret='sk-abcdefghijk123456789',safe=modelFailureNotification({...entry,model:secret,upstreamMessage:'Authorization: Bearer '+secret+' https://private.example/api?token=hidden'});assert(!safe.includes(secret));assert(!safe.includes('private.example'));
 const dump=modelFailureNotification({...entry,upstreamMessage:'messages: private user chat'});assert(!dump.includes('private user chat'));
 // Exercise the actual model gateway with a broken stream, rather than only
 // inserting a notice. No network, model spend, or real IM sends are involved.
 const before=feed().length,originalReserve=journal.reserve.bind(journal);journal.reserve=()=>null;
 const agent={id,desired:()=>({epoch:1}),session:{snapshotEvents:()=>[]},factory:{journal,tickets:new Map(),management:{options:()=>({provider:'fixture',model:'fixture-model'})},autonomy:{},config:{}},ctx:{llm:{prepareCall:async()=>{throw Object.assign(Error('Stream ended without finish_reason'),{code:'MODEL_EXECUTION_FAILED'});}}}};
 let reviewError;await assert.rejects(modelRequest(agent,new AbortController().signal,{turn:1,epoch:1,lane:'foreground',purpose:'conversation-review',messages:[]}),error=>{reviewError=error;return error.message==='MODEL_EXECUTION_FAILED';});
 assert.equal(feed().length,before,'Review disposition is decided by the caller before notifying');
 recordReviewUnavailable(agent,reviewError,{response:{rid:'draft'},options:{turn:1},degraded:true});
 journal.reserve=originalReserve;assert.equal(feed().length,before+1);assert.equal(journal.value(id,'modelFailures').foreground.purpose,'conversation-review');assert.match(feed().at(-1).text,/基础校验/);
 // Session changes cannot deliver a previous owner's error to the new owner.
 state.sessionId='another-session';state.messages=[{seq:feed().at(-1).seq}];await remote.tick();assert.equal(received.length,3);
 console.log('PASS: diagnostics, review stage, paused delivery, durable dedup, restart, no backfill, unknown receipt, cancellation exclusion, prepare failure, redaction, real gateway hook, session fence. Synthetic adapter only.');
}finally{await remote.close();journal.close();const actual=await fs.realpath(dir),parent=await fs.realpath(os.tmpdir());assert.equal(path.dirname(actual),parent);assert(path.basename(actual).startsWith('human-model-notice-'));await fs.rm(actual,{recursive:true,force:true});}
