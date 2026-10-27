// DSH Web test driver. No tools; bounded text-only provider calls. Experimental, pinned ABI.
import {DatabaseSync} from 'node:sqlite';
import {Service,createScope,agentEvents,z,createAssistantMessage,interruptedTurnClosers} from './api.mjs';
import {DomainMemory} from './domain.mjs';
import {RelationshipChoice} from './relationship-choice.mjs';
import {RollingDialogueSummary} from './dialogue-summary.mjs';
import {commitLearningOffer} from './learning-engagement.mjs';
import {AutonomyStore} from './autonomy-store.mjs';
import {PersonaDevelopment} from './persona-development.mjs';
import {MemoryLifecycle} from './memory-lifecycle.mjs';
import {runDevelopmentReview} from './development-runtime.mjs';
import {WorkObservation} from './work-observation.mjs';
import {runWorkObservation} from './work-observation-runtime.mjs';
import {runAutonomyTurn} from './autonomy.mjs';
import {ReminderStore,runReminderTurn} from './reminders.mjs';
import {EventLog} from './event-log.mjs';
import {HumanManagement} from './management.mjs';
import {commitTask} from './scheduled-tasks.mjs';
import {commitSocialContact} from './social.mjs';
import {GoalEngine} from './goals.mjs';
import {pendingOwnerCommand} from './owner-commands.mjs';
import path from 'node:path';
import {ActionStore} from './actions.mjs';
import {ToolExecutor} from './tool-executor.mjs';
import {CognitionStore} from './cognition.mjs';
import {registerMcpCapabilities} from './capability-mcp.mjs';
import {CustomMcpCapabilities} from './capability-custom-mcp.mjs';
import {registerBridgeCapabilities} from './capability-bridge.mjs';
import {registerReportCapability} from './capability-report.mjs';
import {parentCapabilityRequest} from './capability-parent.mjs';
import {nextActionWork,runActionTurn} from './action-loop.mjs';
import {ownerTurnPlan,beginOwnerBatch,bindOwnerResponse,restoreOwnerBatch,finishOwnerBatch,recoverOwnerBatch} from './owner-turns.mjs';

export class ControlJournal {
  constructor(file) {
    this.file=file;
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS control(id TEXT PRIMARY KEY, desired TEXT NOT NULL, epoch INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, next_tick INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS reservation(id TEXT PRIMARY KEY, agent TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, agent TEXT, kind TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS metadata(agent TEXT,key TEXT,value TEXT,PRIMARY KEY(agent,key));
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY,agent TEXT,kind TEXT,text TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS user_request(agent TEXT,request_id TEXT,text TEXT,message_id TEXT,status TEXT,PRIMARY KEY(agent,request_id));
      CREATE TABLE IF NOT EXISTS response_stage(id TEXT PRIMARY KEY,agent TEXT,turn INTEGER,epoch INTEGER,kind TEXT,payload TEXT,state TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS retirement(id TEXT PRIMARY KEY,phase TEXT,manifest TEXT,created INTEGER);
      CREATE TABLE IF NOT EXISTS attempt(id TEXT PRIMARY KEY,agent TEXT,turn INTEGER,epoch INTEGER,state TEXT,request TEXT,config TEXT,usage TEXT,usage_confidence TEXT,error TEXT,text_chars INTEGER DEFAULT 0,reasoning_chars INTEGER DEFAULT 0,started INTEGER,ended INTEGER);`);
    if(!this.db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='event_key'))this.db.exec('ALTER TABLE outbox ADD COLUMN event_key TEXT');
    if(!this.db.prepare('PRAGMA table_info(attempt)').all().some(c=>c.name==='failure_facts'))this.db.exec('ALTER TABLE attempt ADD COLUMN failure_facts TEXT');
    if(!this.db.prepare('PRAGMA table_info(attempt)').all().some(c=>c.name==='trigger'))this.db.exec('ALTER TABLE attempt ADD COLUMN trigger TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS outbox_event ON outbox(agent,event_key)');
    this.db.exec('CREATE INDEX IF NOT EXISTS outbox_agent_kind_time ON outbox(agent,kind,created DESC,seq DESC)');
    this.db.exec('CREATE INDEX IF NOT EXISTS attempt_agent_started ON attempt(agent,started)');
    this.auditSequence=Math.max(this.db.prepare('SELECT max(seq) AS n FROM audit').get().n??0,this.value('__system__','auditSequence',0));
    this.events=new EventLog(this.db);
    const cursor=this.db.prepare("SELECT max(CAST(substr(id,5) AS INTEGER)) AS n FROM human_event WHERE id LIKE 'r:a:%'").get().n??0;
    for(const row of this.db.prepare('SELECT * FROM audit WHERE seq>? ORDER BY seq').all(cursor))this.events.append(row.agent,'a:'+String(row.seq).padStart(16,'0'),row.kind,JSON.parse(row.data));
    if(!this.value('__system__','attemptTraceBackfill',false)){
      for(const row of this.db.prepare('SELECT id,agent,state,request,config,usage,usage_confidence,error,started,ended FROM attempt').all()){const request=JSON.parse(row.request),config=JSON.parse(row.config??'{}');this.events.append(row.agent,'q:'+row.id,'attempt-'+row.state,{time:row.ended??row.started,attemptId:row.id,taskId:request.taskId,roundId:request.roundId,lane:request.lane,origin:request.lane==='foreground'?'owner':'timer',provider:config.provider,model:config.model,usage:JSON.parse(row.usage??'null'),usageConfidence:row.usage_confidence,error:row.error,historical:true});}
      this.put('__system__','attemptTraceBackfill',true);
    }
  }
  ensure(id){this.db.prepare("INSERT OR IGNORE INTO control(id,desired,epoch) VALUES(?,'paused',0)").run(id);}
  get(id){return this.db.prepare('SELECT * FROM control WHERE id=?').get(id);}
  set(id,desired){this.db.prepare('UPDATE control SET desired=?, epoch=epoch+1 WHERE id=?').run(desired,id);}
  tickAt(id,time){this.db.prepare('UPDATE control SET next_tick=? WHERE id=?').run(time,id);}
  audit(id,kind,data){const entry={time:Date.now(),...data},seq=++this.auditSequence;this.db.prepare('INSERT INTO audit(seq,agent,kind,data) VALUES(?,?,?,?)').run(seq,id,kind,JSON.stringify(entry));this.put('__system__','auditSequence',seq);this.events.append(id,'a:'+String(seq).padStart(16,'0'),kind,entry);}
  reserve(id,amount,limit,attempt){
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(this.get(id).used+amount>limit){this.db.exec('ROLLBACK');return undefined;}
      const rid=crypto.randomUUID();
      if(this.safety&&!this.safety.reserveBudget(rid,id,amount,{budgetClass:attempt?.request?.budgetClass??'legacy',created:attempt?.request?.budgetTime??Date.now(),roundId:attempt?.request?.roundId})){this.db.exec('ROLLBACK');return undefined;}
      this.db.prepare('UPDATE control SET used=used+? WHERE id=?').run(amount,id);
      this.db.prepare("INSERT INTO reservation VALUES(?,?,?,'pending')").run(rid,id,amount);
      if(attempt)this.beginAttempt(id,rid,attempt.turn,attempt.epoch,attempt.request);
      this.db.exec('COMMIT');return rid;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  settle(rid,actual){
    this.safety?.settleBudget(rid,actual);
    const row=this.db.prepare('SELECT * FROM reservation WHERE id=?').get(rid);
    if(!row||row.status!=='pending')return;
    // Missing usage keeps the full conservative reservation. Never assumes a canceled request was free.
    const amount=actual===undefined?row.amount:Math.max(row.amount,actual);
    this.db.exec('BEGIN IMMEDIATE');
    this.db.prepare('UPDATE control SET used=used+? WHERE id=?').run(amount-row.amount,row.agent);
    this.db.prepare("UPDATE reservation SET status='settled',amount=? WHERE id=?").run(amount,rid);
    this.db.exec('COMMIT');
  }
  release(rid){
    this.safety?.releaseBudget(rid);
    const row=this.db.prepare('SELECT * FROM reservation WHERE id=?').get(rid);
    if(!row||row.status!=='pending')return;
    this.transaction(()=>{
      this.db.prepare('UPDATE control SET used=used-? WHERE id=?').run(row.amount,row.agent);
      this.db.prepare("UPDATE reservation SET status='released',amount=0 WHERE id=?").run(rid);
    });
  }
  transaction(fn){
    const nested=(this.transactionDepth??0)>0,name='human_tx_'+(this.transactionSequence=(this.transactionSequence??0)+1);
    this.db.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');this.transactionDepth=(this.transactionDepth??0)+1;
    try{const value=fn();this.db.exec(nested?'RELEASE '+name:'COMMIT');return value;}
    catch(e){if(nested){this.db.exec('ROLLBACK TO '+name);this.db.exec('RELEASE '+name);}else this.db.exec('ROLLBACK');throw e;}
    finally{this.transactionDepth--;}
  }
  beginAttempt(id,rid,turn,epoch,request){this.db.prepare("INSERT OR IGNORE INTO attempt(id,agent,turn,epoch,state,request,started,trigger) VALUES(?,?,?,?,'prepared',?,?,?)").run(rid,id,turn,epoch,JSON.stringify(request),Date.now(),request?.purpose==='conversation-summary'?'conversation-summary':request?.admittedIds?.length?'new-input':'autonomous-tick');}
  longRunStats(id){
    const baseline=this.value(id,'longRunBaseline',null);if(!baseline)return null;
    const groups=this.db.prepare("SELECT trigger,state,count(*) AS calls,sum(CASE WHEN usage_confidence='reported' THEN COALESCE(json_extract(usage,'$.totalTokens'),0) ELSE 0 END) AS reportedTokens,max(ended) AS lastEnded FROM attempt WHERE agent=? AND started>=? GROUP BY trigger,state").all(id,baseline.startedAt);
    const count=filter=>groups.filter(filter).reduce((n,g)=>n+g.calls,0);
    return {...baseline,elapsedMs:Date.now()-baseline.startedAt,observation24hElapsed:Date.now()-baseline.startedAt>=86400000,attempts:count(()=>true),autonomousAttempts:count(g=>g.trigger==='autonomous-tick'),inputAttempts:count(g=>g.trigger==='new-input'),summaryAttempts:count(g=>g.trigger==='conversation-summary'),expressions:count(g=>g.state==='completed'),waits:count(g=>g.state==='wait'),failures:count(g=>['failed','output-limit','interrupted'].includes(g.state)),cancelled:count(g=>g.state==='cancelled'),inflight:count(g=>['prepared','dispatched','response-ready'].includes(g.state)),reportedTokens:groups.reduce((n,g)=>n+(g.reportedTokens??0),0),conservativeTokens:this.get(id).used-baseline.initialCumulativeUsed,lastEnded:Math.max(0,...groups.map(g=>g.lastEnded??0))||null};
  }
  dispatchAttempt(rid,config){this.db.prepare("UPDATE attempt SET state='dispatched',config=? WHERE id=?").run(JSON.stringify(config),rid);}
  endAttempt(rid,outcome){this.db.prepare('UPDATE attempt SET state=?,usage=?,usage_confidence=?,error=?,text_chars=?,reasoning_chars=?,failure_facts=?,ended=? WHERE id=?').run(outcome.state,JSON.stringify(outcome.usage??null),outcome.usageConfidence??'unknown',outcome.error??null,outcome.textChars??0,outcome.reasoningChars??0,JSON.stringify(outcome.failureFacts??null),Date.now(),rid);const row=this.db.prepare('SELECT * FROM attempt WHERE id=?').get(rid);if(row){const request=JSON.parse(row.request),config=JSON.parse(row.config??'{}');this.audit(row.agent,'attempt-'+outcome.state,{attemptId:rid,taskId:request.taskId,roundId:request.roundId,lane:request.lane,origin:request.lane==='foreground'?'owner':'timer',provider:config.provider,model:config.model,usage:outcome.usage??null,usageConfidence:outcome.usageConfidence??'unknown',reserved:this.safety?.budget.entries.get(rid)?.amount,error:outcome.error,started:row.started,ended:row.ended});}}
  assertAdmitted(id){this.safety?.assert(id);if(this.db.prepare('SELECT 1 FROM retirement WHERE id=?').get(id))throw new Error('SESSION_RETIRED');}
  stageResponse(id,rid,turn,epoch,kind,payload){
    this.transaction(()=>{
      this.assertAdmitted(id);
      if(this.get(id).epoch!==epoch||this.get(id).desired!=='running')throw new Error('STALE_RESULT');
      this.db.prepare("INSERT INTO response_stage VALUES(?,?,?,?,?,?,'ready',?)").run(rid,id,turn,epoch,kind,JSON.stringify(payload),Date.now());
      this.db.prepare("UPDATE attempt SET state='response-ready' WHERE id=?").run(rid);
    });
  }
  staged(id){return this.db.prepare("SELECT * FROM response_stage WHERE agent=? AND state='ready' ORDER BY created").all(id);}
  recoverResponses(session){
    const recovered=[];
    for(const row of this.staged(session.id)){
      const payload=JSON.parse(row.payload),events=session.snapshotEvents();
      const existing=row.kind==='MESSAGE'?events.some(e=>e.type==='assistant/message'&&e.data.message.id===payload.data.message.id):events.some(e=>e.type==='turn/end'&&e.data.turn===row.turn&&e.data.reason.kind==='completed');
      const start=events.findLast(e=>e.type==='turn/start'&&e.data.turn===row.turn);
      const closed=events.some(e=>e.type==='turn/end'&&e.data.turn===row.turn);
      const batch=payload.ownerBatch?this.value(session.id,'ownerBatch',null):null;
      const batchValid=!payload.ownerBatch||batch?.id===payload.ownerBatch.id&&!batch.invalidated&&!batch.failed;
      const valid=existing||start&&!closed&&batchValid&&this.get(session.id).epoch===row.epoch&&!this.db.prepare('SELECT 1 FROM retirement WHERE id=?').get(session.id);
      if(!valid){this.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(row.id);this.settle(row.id);this.endAttempt(row.id,{state:'interrupted',usageConfidence:'unknown',error:'STALE_STAGED_RESULT'});continue;}
      if(!existing&&row.kind==='MESSAGE')session.append('assistant/message',payload.data,{surfaceOp:'append'});
      if(!closed){
        if(!events.some(e=>e.type==='step/end'&&e.data.turn===row.turn&&e.data.step===1))session.append('step/end',{turn:row.turn,step:1});
        session.append('turn/end',{turn:row.turn,reason:{kind:'completed'}});
      }
      recovered.push(row.id);
    }
    return recovered;
  }
  commitResponse(rid){
    const row=this.db.prepare("SELECT * FROM response_stage WHERE id=? AND state='ready'").get(rid);if(!row)return;
    const payload=JSON.parse(row.payload),usage=payload.usage;
    if(row.kind==='WAIT')this.publish(row.agent,'没有需要表达的新内容，等待下一次事件。','wait','wait:'+rid);
    this.settle(rid,usage?usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)+usage.outputTokens:undefined);
    this.transaction(()=>{
      this.endAttempt(rid,{state:row.kind==='WAIT'?'wait':'completed',usage,usageConfidence:usage?'reported':'unknown',textChars:payload.textChars,reasoningChars:payload.reasoningChars});
      if(usage){this.put(row.agent,'lastUsage',usage);this.put(row.agent,'lastUsageConfidence','reported');}
      this.put(row.agent,'lastError',null);
      if(payload.autonomyCommit&&row.kind==='MESSAGE'){
        const committed=payload.autonomyCommit;
        this.put(row.agent,'lastAutonomousContact',Math.max(this.value(row.agent,'lastAutonomousContact',0),committed.contactAt));
        if(committed.noteId)this.put(row.agent,'learning-shared:'+committed.noteId,true);
        if(committed.learningOffer)commitLearningOffer(this,row.agent,committed.learningOffer);
        if(committed.careAnchor)this.put(row.agent,'care-user-anchor',committed.careAnchor);
        if(committed.social)commitSocialContact(this,row.agent,committed.social);
      }
      if(payload.reminderCommit&&row.kind==='MESSAGE'){
        const committed=payload.reminderCommit;
        commitTask(this,row.agent,committed);
        this.put(row.agent,'lastAutonomousContact',Math.max(this.value(row.agent,'lastAutonomousContact',0),committed.contactAt));
      }
      if(payload.ownerBatch&&this.value(row.agent,'ownerBatch',null)?.id===payload.ownerBatch.id)this.put(row.agent,'ownerBatch',null);
      if(row.kind==='MESSAGE'){
        const a=this.db.prepare('SELECT request FROM attempt WHERE id=?').get(rid),request=a?JSON.parse(a.request):{},messageId=payload.data?.message?.id,localInputs=this.value(row.agent,'local-admitted:'+messageId,[]),inputIds=payload.ownerBatch?.inputIds??request.admittedIds??localInputs;
        // The native reply is durable before recording this relationship. Keep
        // the whole input batch for reconstruction after restart or compaction.
        if(messageId&&Array.isArray(inputIds)&&inputIds.every(key=>typeof key==='string')&&(inputIds.length||request.lane||payload.autonomyCommit||payload.reminderCommit))this.put(row.agent,'dialogue-origin:'+messageId,{inputIds,lane:inputIds.length?'foreground':'autonomous',turn:row.turn,attemptId:rid});
        this.audit(row.agent,'response-published',{taskId:request.taskId,roundId:request.roundId,attemptId:rid,messageId,inputId:localInputs[0],noteId:payload.autonomyCommit?.noteId??null,origin:request.lane==='foreground'||localInputs.length?'owner':'timer'});
      }
      // Relationship evidence is committed only after the native assistant event
      // is durable. A malformed/revoked optional record must not lose the reply.
      if(row.kind==='MESSAGE'&&payload.relationshipCommit&&this.relationship){
        try{this.relationship.commitDecision(row.agent,payload.relationshipCommit);}
        catch(error){this.audit(row.agent,'relationship-choice-held',{messageId:payload.data?.message?.id,code:/^[A-Z_]{3,64}$/u.test(error.message)?error.message:'RELATIONSHIP_COMMIT_FAILED'});}
      }
      // The native event is the canonical content owner after durable publication.
      this.db.prepare("UPDATE response_stage SET state='committed',payload='null' WHERE id=?").run(rid);
    });
  }
  recoverAttempts(id){
    for(const r of this.db.prepare("SELECT * FROM attempt WHERE agent=? AND state IN ('prepared','dispatched','generated')").all(id)){
      if(r.state==='prepared')this.release(r.id);else this.settle(r.id);
      this.endAttempt(r.id,{state:'interrupted',...(r.state==='generated'&&r.usage_confidence==='reported'?{usage:JSON.parse(r.usage),usageConfidence:'reported'}:{usageConfidence:r.state==='prepared'?'not-dispatched':'unknown'}),error:'PROCESS_INTERRUPTED'});
    }
  }
  put(id,key,value){this.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?,?)').run(id,key,JSON.stringify(value));}
  value(id,key,fallback){const r=this.db.prepare('SELECT value FROM metadata WHERE agent=? AND key=?').get(id,key);return r?JSON.parse(r.value):fallback;}
  publish(id,text,kind='assistant',eventKey=null,created=Date.now()){
    if(eventKey){
      const existing=this.db.prepare('SELECT seq FROM outbox WHERE agent=? AND event_key=?').get(id,eventKey);if(existing)return existing.seq;
      // One-time mapping of the pre-0.1.0-webtest.2 rows to durable native identities.
      const legacy=this.db.prepare('SELECT seq FROM outbox WHERE agent=? AND event_key IS NULL AND kind=? AND text=? ORDER BY seq LIMIT 1').get(id,kind,text);
      if(legacy){this.db.prepare('UPDATE outbox SET event_key=? WHERE seq=?').run(eventKey,legacy.seq);return legacy.seq;}
    }
    return Number(this.db.prepare('INSERT INTO outbox(agent,kind,text,created,event_key) VALUES(?,?,?,?,?)').run(id,kind,text,created,eventKey).lastInsertRowid);
  }
  reconcile(session){
    this.assertAdmitted(session.id);
    const id=session.id,events=session.snapshotEvents(),pending=new Map(),delivered=[];
    const textOf=m=>m.content.filter(c=>c.type==='text').map(c=>c.text).join('');
    for(const e of events){
      if(e.type==='agent/inbox/spliced'){
        const lists=pending.get('lists')??{'next-step':[],'next-turn':[]};pending.set('lists',lists);
        lists[e.data.target].splice(e.data.start,e.data.removedCount??0,...e.data.inserted);
      }
      if(e.type==='user/message')delivered.push({key:'user:'+e.data.id,kind:'user',text:textOf(e.data),time:e.time});
      if(e.type==='assistant/message')delivered.push({key:'assistant:'+e.data.message.id,kind:'assistant',text:textOf(e.data.message),time:e.time});
      if(e.type==='turn/end'&&['error','aborted'].includes(e.data.reason.kind)){
        const code=e.data.reason.error?.message??'USER_STOPPED';
        const label=e.data.reason.kind==='aborted'?'本轮已停止，已领取的消息保留在历史中。':['OUTPUT_LIMIT','MODEL_FINISH_max-tokens'].includes(code)?'输出达到上限，本轮未投递回复。':'本轮调用失败，未投递回复。';
        delivered.push({key:'status:'+e.seq,kind:'status',text:label,time:e.time});
      }
    }
    const lists=pending.get('lists');if(lists)for(const m of [...lists['next-step'],...lists['next-turn']])if(m.role==='user')delivered.push({key:'user:'+m.id,kind:'user',text:textOf(m)});
    this.transaction(()=>{
      for(const row of delivered)this.publish(id,row.text,row.kind,row.key,row.time??Date.now());
      const assistants=delivered.filter(r=>r.kind==='assistant');
      this.put(id,'successes',assistants.length);
      if(assistants.length)this.put(id,'memory',assistants.at(-1).text.slice(0,300));
    });
  }
  close(){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close();}
}

const InboxSchema=z.object({'next-turn':z.array(z.any()),'next-step':z.array(z.any())});
export const inboxProjection={key:'inbox',stateSchema:InboxSchema,stateVersion:1,
  init:()=>({'next-turn':[],'next-step':[]}),
  apply:(state,event)=>{
    if(event.type!=='agent/inbox/spliced')return state;
    const next=structuredClone(state),d=event.data;
    next[d.target].splice(d.start,d.removedCount??0,...d.inserted);return next;
  },wire:{viewSchema:InboxSchema,view:s=>s}};
const BoundarySchema=z.object({openTurnStartSeq:z.number().nullable(),lastStepStartSeq:z.number().nullable(),lastStepBoundary:z.object({kind:z.enum(['start','end']),seq:z.number()}).nullable(),lastTurn:z.number()});
export const boundaryProjection={key:'turnBoundary',stateSchema:BoundarySchema,stateVersion:1,
  init:()=>({openTurnStartSeq:null,lastStepStartSeq:null,lastStepBoundary:null,lastTurn:0}),
  apply:(s,e)=>{
    if(e.type==='turn/start')return {...s,openTurnStartSeq:e.seq,lastTurn:e.data.turn};
    if(e.type==='turn/end')return {...s,openTurnStartSeq:null};
    if(e.type==='step/start')return {...s,lastStepStartSeq:e.seq,lastStepBoundary:{kind:'start',seq:e.seq}};
    if(e.type==='step/end')return {...s,lastStepBoundary:{kind:'end',seq:e.seq}};
    return s;
  }};

class HumanInbox {
  constructor(agent){this.agent=agent;}
  state(){return this.agent.ctx.sessionProjections.stateOf(this.agent.session,'inbox');}
  get nextTurn(){return [...this.state()['next-turn']];}
  get nextStep(){return [...this.state()['next-step']];}
  splice(target,start,deleteCount,inserted){
    this.agent.assertLive();
    const list=this.state()[target];
    const pos=start<0?Math.max(0,list.length+start):Math.min(start,list.length);
    const removed=list.slice(pos,pos+Math.max(0,deleteCount));
    this.agent.session.append('agent/inbox/spliced',{target,start:pos,removedCount:removed.length,inserted});
    for(const m of inserted)this.agent.events.emit('agent/inbox/inserted',{message:m});
    return removed;
  }
  append(t,m){this.splice(t,this.state()[t].length,0,[m]);}
  prepend(t,m){this.splice(t,0,0,[m]);}
  clear(){for(const t of ['next-step','next-turn']){const gone=this.splice(t,0,this.state()[t].length,[]);for(const m of gone)this.agent.events.emit('agent/inbox/discarded',{message:m});}}
  replace(id,m){for(const t of ['next-step','next-turn']){const i=this.state()[t].findIndex(x=>x.id===id);if(i>=0){this.splice(t,i,1,[m]);return true;}}return false;}
  remove(id){for(const t of ['next-step','next-turn']){const i=this.state()[t].findIndex(x=>x.id===id);if(i>=0){this.splice(t,i,1,[]);return true;}}return false;}
}

export class HumanAgent {
  constructor(factory,session,writer,options,parent){
    this.factory=factory;this.id=session.id;this.session=session;this.writer=writer;
    this.options=Object.freeze({...options});this.status='idle';this.ready=false;this.closed=false;
    this.scope=createScope(factory.runtime.ctx,this,parent?{parent}:{});this.ctx=this.scope.ctx;
    this.events=agentEvents(this.ctx,this);this.inbox=new HumanInbox(this);
    this.active=undefined;this.cancelController=undefined;this.wake=false;this.timer=undefined;this.reminderTimer=undefined;this.ownerTimer=undefined;
    this.cause=undefined;this.lastError=undefined;this.cycles=0;
    factory.journal.ensure(this.id);
    if(factory.journal.get(this.id).desired==='running'){factory.journal.set(this.id,'paused');factory.journal.audit(this.id,'restart-paused',{});}
    if(factory.config.budgetRound&&factory.journal.value(this.id,'budgetRound',null)!==factory.config.budgetRound){
      factory.journal.transaction(()=>{
        factory.journal.put(this.id,'budgetBase',factory.journal.get(this.id).used);
        factory.journal.put(this.id,'budgetRound',factory.config.budgetRound);
        factory.journal.audit(this.id,'budget-round',{round:factory.config.budgetRound,allowance:factory.config.tokenBudget,priorUsed:factory.journal.get(this.id).used});
      });
    }
    // The native JSONL provider already routes published events to its owned writer.
    // A second append listener would duplicate seqs. Custom backends must own one routing path.
  }
  assertLive(){if(this.closed)throw new Error('Agent is disposed');this.factory.journal.assertAdmitted(this.id);}
  desired(){return this.factory.journal.get(this.id);}
  setStatus(s){if(s!==this.status){this.status=s;this.events.emit('agent/status',{status:s});}}
  send(m,target,wakeup){this.assertLive();this.inbox.append(target,m);if(wakeup){this.wake=true;this.pump();}}
  followup(m){this.send(m,'next-turn',true);}
  steer(m){this.send(m,'next-step',true);}
  inject(m){this.send(m,'next-step',false);}
  cancel(cause,options={}){
    if(this.closed)return;
    if(['user','disposed'].includes(cause.kind)){
      const journal=this.factory.journal;
      if(this.desired().desired!=='paused'){journal.set(this.id,'paused');journal.audit(this.id,'cancel-paused',{cause:cause.kind,epoch:this.desired().epoch});journal.put(this.id,'stopReason',cause.kind==='user'?'user':'shutdown');}
      this.wake=false;clearTimeout(this.timer);this.timer=undefined;clearTimeout(this.reminderTimer);this.reminderTimer=undefined;clearTimeout(this.ownerTimer);this.ownerTimer=undefined;
    }
    if(!options.keepInbox)this.inbox.clear();
    if(this.cancelController&&!this.cancelController.signal.aborted){this.cause=cause;this.cancelController.abort(cause);}
    if(cause.kind==='disposed'){this.wake=false;this.ready=false;clearTimeout(this.timer);clearTimeout(this.reminderTimer);}
  }
  async whenIdle(){while(this.active)await this.active;}
  runMaintenance(task){
    this.assertLive();if(this.active)throw new Error('Agent busy');
    this.cancelController=new AbortController();this.cause=undefined;
    const controller=this.cancelController,idle=Promise.withResolvers();this.active=idle.promise;
    return Promise.resolve().then(()=>task(controller.signal)).finally(()=>{
      if(this.active===idle.promise){this.active=undefined;this.cancelController=undefined;}
      idle.resolve();this.pump();
    });
  }
  async flush(){if(!await this.ctx.sessions.flush(this.session))throw new Error('No durability listener');}
  async control(desired){
    this.assertLive();this.factory.journal.set(this.id,desired);
    this.factory.journal.audit(this.id,'control',{desired,epoch:this.desired().epoch});
    clearTimeout(this.timer);this.timer=undefined;
    if(desired==='running'){
      const cycles=this.requestedCycles??this.factory.config.maxCycles,unlimited=cycles===0;
      this.factory.journal.put(this.id,'remaining',unlimited?null:cycles);
      this.factory.journal.put(this.id,'driveMode',unlimited?'continuous':'bounded');
      if(unlimited&&!this.factory.journal.value(this.id,'longRunBaseline',null))this.factory.journal.put(this.id,'longRunBaseline',{startedAt:Date.now(),sessionId:this.id,intervalMs:this.factory.config.intervalMs,initialCumulativeUsed:this.desired().used});
    }
    if(desired!=='running'){this.cancel({kind:'user'},{keepInbox:true});await this.whenIdle();await this.flush();}
    else{this.pump();this.arm();this.armReminder();}
  }
  due(now=Date.now()){
    if(!this.ready||this.closed||this.desired().desired!=='running')return;
    if(now<this.desired().next_tick)return;
    // Coalesce missed ticks, never replay every elapsed interval after sleep.
    this.factory.journal.audit(this.id,'timer-wake',{scheduledAt:this.desired().next_tick,lateMs:Math.max(0,now-this.desired().next_tick)});
    this.factory.journal.tickAt(this.id,now+this.factory.config.intervalMs);
    this.wake=true;this.pump();
  }
  arm(){
    if(this.timer||!this.ready||this.closed||this.desired().desired!=='running')return;
    this.timer=this.ctx.agents.withoutInitiator(()=>setTimeout(()=>{this.timer=undefined;this.due();this.arm();},this.factory.config.intervalMs));
  }
  armReminder(){
    clearTimeout(this.reminderTimer);this.reminderTimer=undefined;
    if(!this.ready||this.closed||this.desired().desired!=='running'||!this.factory.reminders)return;
    const next=this.factory.reminders.nextAt(this.id);if(next===null)return;
    const delay=Math.max(1000,Math.min(2147483647,next-Date.now()));
    this.reminderTimer=this.ctx.agents.withoutInitiator(()=>setTimeout(()=>{this.reminderTimer=undefined;if(!this.closed&&this.desired().desired==='running'){this.reminderWake=true;this.wake=true;this.pump();this.armReminder();}},delay));
  }
  pump(){
    if(!this.ready||this.closed||this.active||!this.wake||this.desired().desired!=='running')return;
    clearTimeout(this.ownerTimer);this.ownerTimer=undefined;
    const ownerPlan=ownerTurnPlan(this);
    if(ownerPlan?.delayMs>0){
      this.factory.journal.put(this.id,'autonomyPhase','collecting-input');
      this.ownerTimer=this.ctx.agents.withoutInitiator(()=>setTimeout(()=>{this.ownerTimer=undefined;this.pump();},ownerPlan.delayMs));return;
    }
    this.wake=false;this.cancelController=new AbortController();this.cause=undefined;
    const controller=this.cancelController,idle=Promise.withResolvers();this.active=idle.promise;
    Promise.resolve().then(()=>{
      this.setStatus('running');return this.ctx.agents.withInitiator(this,()=>this.drive(controller.signal));
    }).catch(e=>{
      this.lastError=e.code??'DRIVER_COMMIT_FAILED';this.wake=false;clearTimeout(this.timer);this.timer=undefined;
      clearTimeout(this.reminderTimer);this.reminderTimer=undefined;
      try{this.factory.journal.set(this.id,'paused');this.factory.journal.put(this.id,'lastError',this.lastError);this.factory.journal.put(this.id,'stopReason','error');}catch{}
    }).finally(()=>{
      if(this.active===idle.promise){this.active=undefined;this.cancelController=undefined;this.setStatus('idle');}
      idle.resolve();this.pump();this.armReminder();
    });
  }
  async drive(signal){
    const reminderOnly=this.reminderWake;this.reminderWake=false;
    if(!this.inbox.nextTurn.length&&!this.inbox.nextStep.length&&pendingOwnerCommand(this))return runAutonomyTurn(this,signal);
    if(this.factory.reminders&&!this.inbox.nextTurn.length&&!this.inbox.nextStep.length){const reminder=this.factory.reminders.due(this.id);if(reminder)return runReminderTurn(this,signal,reminder);}
    if(!this.inbox.nextTurn.length&&!this.inbox.nextStep.length){const action=nextActionWork(this);if(action)return runActionTurn(this,signal,action);}
    if(reminderOnly&&!this.inbox.nextTurn.length&&!this.inbox.nextStep.length)return;
    const ownerPending=this.inbox.nextTurn.length||this.inbox.nextStep.length;
    if(!ownerPending&&this.factory.journal.value(this.id,'remaining',0)===null&&await runWorkObservation(this,signal))return;
    if(!ownerPending&&this.factory.journal.value(this.id,'remaining',0)===null&&await runDevelopmentReview(this,signal))return;
    if(this.factory.autonomy.settings(this.id).enabled||this.factory.config.interactiveOnly&&ownerPending)return runAutonomyTurn(this,signal);
    // Chat-only mode stays online for owner input without an idle model turn.
    // Foreground requests use the same conversation and accounting path as
    // autonomy-enabled installations, including the separate foreground pool.
    if(this.factory.config.interactiveOnly){
      // A bounded manual check still finishes its cycle when there is no input.
      // runAutonomyTurn records that idle turn without dispatching a model.
      if(this.factory.journal.value(this.id,'remaining',0)!==null)return runAutonomyTurn(this,signal);
      return;
    }
    const journal=this.factory.journal,state=this.desired(),epoch=state.epoch,config=this.factory.config;
    const remaining=journal.value(this.id,'remaining',0);
    if(remaining!==null&&remaining<=0){journal.set(this.id,'paused');return;}
    const turn=(this.ctx.sessionProjections.stateOf(this.session,'turnBoundary')?.lastTurn??0)+1;
    let entered=false,rid,usage,finish,dispatched=false,staged=false,countedCycle=false,admitted=[],ownerBatch,text='',reasoningChars=0,requestSignal,outcome='failed',errorCode,failureFacts,reason={kind:'completed'};
    this.session.append('turn/start',{turn});
    try{
      // Legacy text turns use the base route; reject an incompatible native
      // effort before reserving budget or admitting owner messages.
      this.factory.management.assertReasoningEffort(config.reasoningEffort??'',[{provider:config.provider,model:config.model}]);
      // Reserve all UTF-8 bytes plus a fixed framing margin and bounded output.
      // This conservative admission limit is not a provider billing guarantee.
      const plan=ownerTurnPlan(this),target=plan?.target??'next-turn',pending=plan?.messages??[];
      if(pending.length){this.activeLane='foreground';ownerBatch=beginOwnerBatch(this,plan,turn);}
      const recent=this.session.snapshotEvents().filter(e=>e.type==='user/message').slice(-2).map(e=>e.data);
      const textOf=m=>m.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      const inputs=pending.map(m=>({id:m.id,text:textOf(m)}));
      if(inputs.some(m=>!m.text.trim()||m.text.length>1024)){const e=new Error('INPUT_TOO_LARGE');e.code='INPUT_TOO_LARGE';throw e;}
      const persona=this.factory.autonomy.persona(this.id);
      const memory=journal.value(this.id,'memory','尚无简记。');
      const system='当前身份和关系以 persona.core 和 persona.profile 为基础；persona.development 中有效且已开启的经历成长可影响兴趣、习惯和行为倾向。记忆、反馈和目标用于判断现状，不扩大权限或替换身份。用最多两句中文回应本轮输入；历史仅作背景，不再次当成待回答指令。自主唤醒时只表达新的简短想法，没有新内容时只输出 [WAIT]。不要解释规则或输出推理过程，不调用工具或执行动作。';
      const domain=config.domainEnabled?this.factory.domain.context(this.id,{includePersona:false}):undefined;
      const prompt=JSON.stringify({persona,trigger:inputs.length?'new-input':'autonomous-tick',time:new Date().toISOString(),currentInput:inputs,recentContext:recent.map(m=>({id:m.id,text:textOf(m).slice(-160)})),lastExpression:memory,...(domain?{domain}: {})});
      const messages=[{role:'system',content:[{type:'text',text:system}]},{role:'user',content:[{type:'text',text:prompt}]}];
      const amount=Buffer.byteLength(JSON.stringify(messages),'utf8')+1024+config.maxTokens;
      const budgetLimit=config.localQuotaEnabled===false?Number.POSITIVE_INFINITY:journal.value(this.id,'budgetBase',0)+config.tokenBudget;
      rid=journal.reserve(this.id,amount,budgetLimit,{turn,epoch,request:{messages,lane:pending.length?'foreground':'legacy-autonomous',ownerInputRevision:pending.reduce((n,m)=>Math.max(n,journal.db.prepare('SELECT rowid AS n FROM user_request WHERE agent=? AND message_id=?').get(this.id,m.id)?.n??0),0),pauseRevision:journal.value(this.id,'pauseRevision',0),admittedIds:pending.map(m=>m.id),historicalIds:recent.map(m=>m.id)}});
      if(!rid){journal.set(this.id,'paused');journal.put(this.id,'stopReason','budget');reason={kind:'blocked'};return;}
      if(remaining!==null){journal.put(this.id,'remaining',remaining-1);countedCycle=true;}
      admitted=pending.length?this.inbox.splice(target,0,pending.length,[]):[];
      this.session.append('step/start',{turn,step:1});entered=true;
      for(const m of admitted){
        if(!this.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===m.id))this.session.append('user/message',m,{surfaceOp:'append'});
        this.events.emit('agent/inbox/claimed',{message:m,turn});
      }
      await this.flush();signal.throwIfAborted();
      journal.beginAttempt(this.id,rid,turn,epoch,{messages,admittedIds:admitted.map(m=>m.id),historicalIds:recent.map(m=>m.id)});
      if(this.desired().epoch!==epoch)throw new Error('STALE_EPOCH');
      const deadline=AbortSignal.timeout(config.requestTimeoutMs??45000);
      requestSignal=AbortSignal.any([signal,deadline]);
      const prepared=await this.ctx.llm.prepareCall({provider:config.provider,model:config.model,maxTokens:config.maxTokens,...(config.reasoningEffort?{reasoningEffort:config.reasoningEffort}:{})},requestSignal);
      requestSignal.throwIfAborted();signal.throwIfAborted();
      journal.dispatchAttempt(rid,prepared.config);dispatched=true;
      await this.factory.allowCall(requestSignal,{agent:this.id,rid,epoch,config:prepared.config,messages});
      journal.audit(this.id,'dispatch',{attemptId:rid,turn,epoch,provider:prepared.config.provider,model:prepared.config.model,maxTokens:prepared.config.maxTokens,reasoningEffort:prepared.config.reasoningEffort,reserved:amount,promptBytes:Buffer.byteLength(JSON.stringify(messages),'utf8'),admittedIds:admitted.map(m=>m.id)});
      for await(const chunk of prepared.stream({...prepared.config,messages,signal:requestSignal})){
        if(chunk.type==='text-delta')text+=chunk.text;
        if(chunk.type==='reasoning-delta')reasoningChars+=chunk.text.length;
        if(chunk.type==='usage')usage=chunk.usage;
        if(chunk.type==='finish')finish=chunk.reason;
        if(text.length>4096)throw new Error('OUTPUT_TOO_LARGE');
      }
      signal.throwIfAborted();requestSignal.throwIfAborted();
      if(finish?.kind!=='stop'){
        const f=finish?.failure,description=String(f?.message??'').toLowerCase();
        failureFacts=f?{code:f.code,status:f.status,mentionsThinking:/thinking|reasoning/.test(description),mentionsAuth:/credential|api.?key|unauthorized/.test(description),mentionsQuota:/quota|balance|credit|insufficient/.test(description),mentionsMessages:/message|system|role/.test(description),mentionsNetwork:/fetch|connect|network|socket|certificate|proxy/.test(description)}:undefined;
        const e=new Error('MODEL_FINISH');e.code=['length','max-tokens'].includes(finish?.kind)?'OUTPUT_LIMIT':f?.code??'MODEL_FINISH_'+finish?.kind;throw e;
      }
      if(this.desired().desired!=='running'||this.desired().epoch!==epoch)throw new Error('STALE_RESULT');
      if(this.factory.domain.persona(this.id).version!==persona.version)throw new Error('STALE_PERSONA');
      if(!text.trim())throw new Error('EMPTY_MODEL_OUTPUT');
      const kind=text.trim()==='[WAIT]'?'WAIT':'MESSAGE';
      journal.audit(this.id,'decision',{epoch,kind});
      const data=kind==='MESSAGE'?{turn,step:1,message:createAssistantMessage({content:[{type:'text',text}],source:{provider:prepared.config.provider,model:prepared.config.model}}),stream:[],...(usage?{usage}:{})}:null;
      if(data)bindOwnerResponse(this,ownerBatch,data.message.id);
      journal.stageResponse(this.id,rid,turn,epoch,kind,{data,usage,textChars:text.length,reasoningChars,...(ownerBatch?{ownerBatch:{id:ownerBatch.id,inputIds:ownerBatch.inputIds}}:{})});staged=true;
      await config.responseCheckpoint?.('after-stage',this);
      signal.throwIfAborted();
      if(this.desired().desired!=='running'||this.desired().epoch!==epoch)throw new Error('STALE_RESULT');
      if(kind==='MESSAGE'){
        this.session.append('assistant/message',data,{surfaceOp:'append'});
      }
      await this.flush();
      await config.responseCheckpoint?.('after-native',this);
      journal.reconcile(this.session);
      outcome=kind==='WAIT'?'wait':'completed';this.cycles++;
      journal.put(this.id,'lastError',null);
    }catch(e){
      errorCode=signal.aborted?'USER_STOPPED':requestSignal?.aborted?'REQUEST_TIMEOUT':typeof e.code==='string'?e.code:'DRIVER_ERROR';
      outcome=signal.aborted?'cancelled':errorCode==='OUTPUT_LIMIT'?'output-limit':'failed';
      reason=signal.aborted?(this.cause?.kind==='owner-supplement'?{kind:'completed'}:{kind:'aborted',reason:this.cause??{kind:'user'}}):{kind:'error',error:{code:'HUMAN_DRIVER_ERROR',message:e.code??e.name}};
      if(signal.aborted)restoreOwnerBatch(this,ownerBatch);else if(ownerBatch)journal.put(this.id,'ownerBatch',{...ownerBatch,failed:true});
      journal.audit(this.id,'failure',{attemptId:rid,code:errorCode,aborted:signal.aborted});
      // Keep provider bodies and credentials out of public errors.
      if(!signal.aborted){this.lastError=errorCode;journal.put(this.id,'lastError',this.lastError);journal.set(this.id,'paused');journal.put(this.id,'stopReason','error');this.wake=false;clearTimeout(this.timer);this.timer=undefined;}
    }finally{
      const usageConfidence=!signal.aborted&&usage&&['stop','length','max-tokens'].includes(finish?.kind)?'reported':dispatched?'unknown':'not-dispatched';
      if(rid&&!staged){if(dispatched)journal.settle(rid,usageConfidence==='reported'?usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)+usage.outputTokens:undefined);else journal.release(rid);
        journal.endAttempt(rid,{state:outcome,usage,usageConfidence,error:errorCode,textChars:text.length,reasoningChars,failureFacts});}
      if(staged&&outcome!=='completed'&&outcome!=='wait'){
        // Keep a native-committed expression; otherwise an explicit cancellation fences it.
        const row=journal.db.prepare('SELECT payload FROM response_stage WHERE id=?').get(rid),payload=JSON.parse(row.payload);
        const committed=payload.data&&this.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===payload.data.message.id);
        if(!committed){journal.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(rid);journal.settle(rid);journal.endAttempt(rid,{state:outcome,usage,usageConfidence,error:errorCode,textChars:text.length,reasoningChars});staged=false;}
      }
      if(usage){journal.put(this.id,'lastUsage',usage);journal.put(this.id,'lastUsageConfidence',usageConfidence);journal.audit(this.id,'usage',{turn,usage,usageConfidence,textChars:text.length,reasoningChars});}
      if(entered)this.session.append('step/end',{turn,step:1});
      this.session.append('turn/end',{turn,reason});await this.flush();finishOwnerBatch(this,ownerBatch);this.activeLane=undefined;
      if(staged)await config.responseCheckpoint?.('after-close',this);
      if(staged)journal.commitResponse(rid);
      journal.reconcile(this.session);
      if(config.domainEnabled)for(const message of admitted??[])this.factory.domain.observe(this.id,message);
      if(countedCycle&&signal.aborted&&this.cause?.kind==='owner-supplement')journal.put(this.id,'remaining',journal.value(this.id,'remaining',0)+1);
      if(journal.value(this.id,'remaining',0)!==null&&journal.value(this.id,'remaining',0)<=0&&this.desired().desired==='running'){journal.set(this.id,'paused');journal.put(this.id,'stopReason','cycle-limit');clearTimeout(this.timer);this.timer=undefined;}
    }
    if(this.inbox.nextTurn.length)this.wake=true;
  }
}

export class HumanFactory extends Service {
  static inject=['agents','sessions','sessionPersistence','sessionProjections','llm'];
  constructor(ctx,config){
    super(ctx,'becomeHuman');this.runtime={ctx};this.config=config;this.journal=new ControlJournal(config.journal);this.handles=new Set();this.closing=false;this.domain=new DomainMemory(this.journal);this.personaDevelopment=new PersonaDevelopment(this.journal,this.domain);this.memoryLifecycle=new MemoryLifecycle(this.journal,this.domain);this.domain.development=this.personaDevelopment;this.domain.lifecycle=this.memoryLifecycle;this.autonomy=new AutonomyStore(this.journal,this.domain);this.goals=new GoalEngine(this.journal,this.domain,this.autonomy);this.actions=new ActionStore(this.journal,this.domain,{root:path.resolve(path.dirname(config.journal),'artifacts'),validNote:(agent,note)=>this.goals.validNote(agent,note),validGoal:(agent,ref,action)=>this.goals.actionAllowed(agent,action)});this.goals.setActions(this.actions);this.tools=new ToolExecutor(this.journal);this.workObservation=new WorkObservation(this.journal,{bridgeSettings:id=>this.tools.configuration(id).bridge});this.domain.workObservation=this.workObservation;this.reminders=new ReminderStore(this.journal);this.management=new HumanManagement(this);this.cognition=new CognitionStore(this.journal,this.domain,{factory:this});this.tickets=new WeakMap();this.inflight=0;
    this.relationship=new RelationshipChoice(this.journal,this.domain);this.journal.relationship=this.relationship;
    this.conversationSummary=new RollingDialogueSummary(this.journal,this.domain);
    this.mcpCapabilities=registerMcpCapabilities(this.tools);
    this.customMcpCapabilities=new CustomMcpCapabilities(this.tools,{configuration:agent=>this.tools.configuration(agent),journal:this.journal});
    this.bridgeCapabilities=registerBridgeCapabilities(this.tools,{request:(operation,input,options)=>parentCapabilityRequest(operation,input,{...options,context:{...options.context,policy:this.tools.configuration(options.context.agent).bridge,policyRevision:this.tools.configuration(options.context.agent).revision}})});
    registerReportCapability(this.tools,this.actions,this.journal);
    this.capabilities=Object.freeze({contractVersion:1,register:(name,descriptor)=>this.tools.register(name,descriptor),catalog:()=>this.controllerSessionId?this.tools.catalog(this.controllerSessionId):[]});
    if(config.sharedBudgetGuard)ctx.on('llm/stream',(options,next)=>this.guardedStream(options,next));
    ctx.sessionProjections.register(inboxProjection);ctx.sessionProjections.register(boundaryProjection);
    ctx.agents.setFactory(this);
    ctx.effect(()=>async()=>{this.closing=true;await Promise.all([...this.handles].map(h=>h.dispose()));await this.customMcpCapabilities.close();await this.mcpCapabilities.close();this.bridgeCapabilities();this.management.close();this.journal.close();},'becomeHuman.ownership');
  }
  createAgent(owner,options){return this.build(owner,options,false);}
  resume(owner,options){return this.build(owner,options,true);}
  async allowCall(signal,ticket){if(this.journal.safety){this.journal.safety.dispatchBudget(ticket.rid);await this.journal.safety.anchor();}this.tickets.set(signal,{...ticket,used:false});}
  async *guardedStream(options,next){
    const ticket=this.tickets.get(options.signal);
    if(!ticket||ticket.used||this.inflight>=1||ticket.agent!==this.controllerSessionId||this.journal.get(ticket.agent)?.epoch!==ticket.epoch||this.journal.get(ticket.agent)?.desired!=='running'||JSON.stringify(options.messages)!==JSON.stringify(ticket.messages)||options.provider!==ticket.config.provider||options.model!==ticket.config.model||options.maxTokens!==ticket.config.maxTokens||options.reasoningEffort!==ticket.config.reasoningEffort){yield {type:'finish',reason:{kind:'error',failure:{code:'UNBUDGETED_MODEL_CALL',message:'Model call refused by shared budget gate'}}};return;}
    this.journal.assertAdmitted(ticket.agent);ticket.used=true;this.inflight++;
    try{yield* next();}finally{this.inflight--;this.tickets.delete(options.signal);}
  }
  async build(owner,options,resume){
    owner.fiber.assertActive();if(this.closing)throw new Error('Factory closing');
    const id=resume?options.resumeSessionId:options.sessionId;
    if(this.controllerSessionId&&this.controllerSessionId!==id)throw new Error('SINGLE_CONTROLLER_ONLY');
    this.journal.assertAdmitted(id);
    const factoryCtx=this.runtime.ctx;
    if(factoryCtx.agents.get(id)||factoryCtx.sessions.get(id))throw new Error('Duplicate live identity');
    options.signal?.throwIfAborted();
    let writer,session,agent,detachAgent,detachSession,unfollow,disposing,ownershipMoved=false;
    const initAbort=new AbortController(),initialized=Promise.withResolvers();
    const onAbort=()=>initAbort.abort(options.signal.reason);
    options.signal?.addEventListener('abort',onAbort,{once:true});
    const dispose=(ownerTriggered=false)=>disposing??=(async()=>{
      initAbort.abort(new Error('Lifecycle disposed'));
      await initialized.promise;
      try{
        if(agent){agent.cancel({kind:'disposed'},{keepInbox:true});await agent.whenIdle();if(detachSession&&!this.journal.safety?.retired(id))await agent.flush();await agent.scope.dispose();agent.closed=true;}
        try{await writer?.close();}catch(e){if(!this.journal.safety?.retired(id))throw e;}
      }finally{detachAgent?.();detachSession?.();this.handles.delete(handle);}
      if(!ownerTriggered&&unfollow)await unfollow();
    })();
    const handle={get agent(){return agent;},dispose:()=>dispose()};this.handles.add(handle);
    try{
      unfollow=owner.effect(()=>()=>{if(disposing||ownershipMoved)return;return dispose(true);});
      if(resume){
        writer=await factoryCtx.sessionPersistence.open(id,'write',{signal:initAbort.signal});
        const read=await writer.read();
        session=factoryCtx.sessions.prepare(id,{meta:writer.header,seed:read.events,inheritedEventCount:writer.inheritedEventCount,eventState:read.eventState});
        const recovered=this.journal.recoverResponses(session);
        for(const closer of interruptedTurnClosers(session.snapshotEvents()))session.append(closer.type,closer.data);
        const suffix=session.snapshotEvents().slice(read.events.length);if(suffix.length)await writer.append(suffix);
        await writer.flush();for(const rid of recovered)this.journal.commitResponse(rid);
      }else{
        session=factoryCtx.sessions.prepare(id,{meta:options.meta,seed:options.seed,inheritedEventCount:options.inheritedEventCount});
        writer=await factoryCtx.sessionPersistence.create(session.header,{inheritedEventCount:session.inheritedEventCount,signal:initAbort.signal});
        if(session.snapshotEvents().length)await writer.append(session.snapshotEvents());
      }
      await writer.flush();initAbort.signal.throwIfAborted();owner.fiber.assertActive();
      agent=new HumanAgent(this,session,writer,options.agentOptions??{},options.parentAgent);
      this.journal.recoverAttempts(id);this.journal.reconcile(session);this.reminders.recover(session);
      // Nest the exact scope disposer into the owner's ordered lifecycle.
      // Otherwise provider unload can unwind the scope before its driver finishes.
      ownershipMoved=true;unfollow();
      const scope=agent.scope;
      unfollow=owner.effect(function*(){yield scope.rawDispose;yield ()=>{if(disposing)return;return dispose(true);};},'becomeHuman.agentLifecycle');
      const storedCount=session.snapshotEvents().length;
      const commit=await options.setup?.(agent.ctx,agent);initAbort.signal.throwIfAborted();owner.fiber.assertActive();
      commit?.commit();initAbort.signal.throwIfAborted();
      const setupSuffix=session.snapshotEvents().slice(storedCount);if(setupSuffix.length){await writer.append(setupSuffix);await writer.flush();}
      detachSession=agent.ctx.sessions.enter(session);detachAgent=factoryCtx.agents.enter(agent,options.parentAgent);
      await recoverOwnerBatch(agent);
      agent.ctx.sessions.announce(session);await factoryCtx.agents.announce(agent,resume?'resume':'startup',initAbort.signal);
      initAbort.signal.throwIfAborted();owner.fiber.assertActive();
      options.signal?.removeEventListener('abort',onAbort);
      agent.ready=true;initialized.resolve();agent.pump();agent.arm();agent.armReminder();return handle;
    }catch(e){initialized.resolve();await dispose();throw e;}
    finally{options.signal?.removeEventListener('abort',onAbort);}
  }
}
