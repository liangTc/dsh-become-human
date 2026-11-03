import {createHash,randomUUID} from 'node:crypto';
import {activityOutcome} from './activity-outcome.mjs';
import {developmentInput} from './knowledge-signals.mjs';
import {recallExperience} from './experience-recall.mjs';
import {ExperienceStrategies,strategyBasis} from './experience-strategy.mjs';
import {createExperienceBehavior} from './behavior-packs/experience/behavior.mjs';
import {experienceService} from './experience-service.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const terminal=new Set(['completed','failed','cancelled']);
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const clip=(value,max)=>String(value??'').slice(0,max);

// Evidence is a receipt of digital activity, not a proof that an external
// statement is true, a task was useful, or the owner was satisfied.
export class ExperienceStore {
  constructor(journal,domain,{clock=()=>Date.now(),tools=null}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.clock=clock;this.tools=tools;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_experience(id TEXT PRIMARY KEY,agent TEXT NOT NULL,task TEXT NOT NULL,basis TEXT NOT NULL,source TEXT,memory TEXT,data TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(agent,task,basis));
      CREATE INDEX IF NOT EXISTS human_experience_agent ON human_experience(agent,created);
      CREATE TABLE IF NOT EXISTS human_experience_reflection(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(agent,request));`);
    this.strategies=new ExperienceStrategies(this);
  }
  table(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  task(agent,id){const row=this.db.prepare('SELECT * FROM autonomy_task WHERE agent=? AND id=?').get(agent,id);return row?{...row,checkpoint:parse(row.checkpoint)}:null;}
  eventEvidence(agent,task){
    const ids=task.checkpoint?.pluginEventIds??[];
    if(!ids.length)return {complete:true,development:false,refs:[]};
    if(!this.table('human_plugin_event'))return {complete:false,development:false,refs:[]};
    const get=this.db.prepare('SELECT id,source,fingerprint,digest,data FROM human_plugin_event WHERE agent=? AND id=?');
    const rows=[...new Set(ids)].map(id=>get.get(agent,id)),present=rows.filter(Boolean);
    return {complete:present.length===rows.length,development:present.some(row=>developmentInput(JSON.stringify(parse(row.data)?.payload??{}))),refs:present.map(({id,source,fingerprint,digest})=>({id,source,fingerprint,digest}))};
  }
  receipt(task){const c=task.checkpoint??{};return {taskId:task.id,kind:task.kind,status:task.status,behaviorId:c.behaviorId??null,question:clip(c.plan?.question??c.candidate?.question,240),expected:clip(c.plan?.value,400),reason:c.reason??null,noteId:c.noteId??null,actionId:c.actionId??null,behaviorResult:c.behaviorResult??null};}
  recordTask(agent,taskId){
    this.journal.assertAdmitted(agent);if(!this.table('autonomy_task'))return null;
    const task=this.task(agent,taskId);if(!task||!terminal.has(task.status)||task.kind==='behavior-choice')return null;
    const receipt=this.receipt(task),basis=hash(receipt),prior=this.db.prepare('SELECT id FROM human_experience WHERE agent=? AND task=? AND basis=?').get(agent,taskId,basis);if(prior){const saved=this.get(agent,prior.id);this.strategies.settle(agent,task,saved);return saved;}
    const c=task.checkpoint,refs=[];
    if(c.goal&&this.table('goal_record'))refs.push(...(parse(this.db.prepare('SELECT refs FROM goal_record WHERE agent=? AND id=?').get(agent,c.goal.id)?.refs)??[]));
    if(c.noteId&&this.table('learning_note')){const note=this.db.prepare('SELECT source_id FROM learning_note WHERE agent=? AND id=?').get(agent,c.noteId);if(note)refs.push(note.source_id);}
    const root=c.goal?'goal:'+c.goal.id:'task:'+task.id;
    const events=this.eventEvidence(agent,task);
    const development=events.development||developmentInput([receipt.question,receipt.expected,c.matterContract?.title??''].join(' '))||refs.some(ref=>this.domain.sourceIsDevelopmentTest(agent,ref));
    const outcome=activityOutcome(task);
    const real=outcome.growthEvidence&&events.complete&&!development&&receipt.behaviorId!=='reflect-experience'&&!secret(JSON.stringify(receipt))&&refs.every(ref=>this.domain.sourceUsable(agent,ref));
    const data={version:1,outcome,receipt:{...receipt,behaviorResult:receipt.behaviorResult?{status:receipt.behaviorResult.status,summary:clip(receipt.behaviorResult.summary,600),jobId:receipt.behaviorResult.jobId??null,resultDigest:receipt.behaviorResult.resultDigest??null,...(receipt.behaviorResult.preview?{preview:{text:clip(receipt.behaviorResult.preview.text,1200),truncated:receipt.behaviorResult.preview.truncated===true,evidenceStatus:'tool-returned-unverified'}}:{})}:null},basis,root,refs:[...new Set(refs)],sourceVersions:[...new Set(refs)].map(id=>({id,hash:this.db.prepare('SELECT hash FROM source_record WHERE agent=? AND id=?').get(agent,id)?.hash})),development,growthEligible:real,ownerSatisfaction:'unknown',meaning:'observed-digital-outcome',interpretationVerified:false};
    data.eventEvidence=events.refs;
    return this.journal.transaction(()=>{
      const id=randomUUID(),now=this.clock();let source=null,memory=null;
      if(real){source=randomUUID();const body=JSON.stringify({kind:'digital-experience',experienceId:id,taskId:task.id,status:task.status,intention:receipt.question,expected:receipt.expected,result:data.receipt.behaviorResult?.summary??receipt.reason??'已记录执行状态，效果需另行核验。'});
        this.domain.source(agent,{id:source,kind:'trusted-result',body,root,occurred:now});
        memory=this.domain.save(agent,{type:'episode',truth:'inferred',refs:[source,...data.refs],confidence:.7,payload:{subject:'agent',experienceId:id,intention:receipt.question,status:task.status,summary:clip(data.receipt.behaviorResult?.summary??receipt.reason??'实际执行状态已记录。',500),ownerSatisfaction:'unknown',evidenceKind:'digital-execution-receipt'}});
      }
      this.db.prepare('INSERT INTO human_experience VALUES(?,?,?,?,?,?,?,?)').run(id,agent,taskId,basis,source,memory,JSON.stringify(data),now);
      this.journal.audit(agent,'experience-recorded',{experienceId:id,taskId,status:task.status,development:!real,sourceId:source,memoryId:memory});const saved=this.get(agent,id);this.strategies.settle(agent,task,saved);return saved;
    });
  }
  get(agent,id){const row=this.db.prepare('SELECT * FROM human_experience WHERE agent=? AND id=?').get(agent,id);return row?{...row,data:parse(row.data)}:null;}
  valid(agent,row,{includeDevelopment=false}={}){
    if(!row||row.agent!==agent||(row.data.development||row.data.growthEligible===false||row.data.refs.some(ref=>this.domain.sourceIsDevelopmentTest(agent,ref)))&&!includeDevelopment)return false;
    const task=this.task(agent,row.task);if(!task||hash(this.receipt(task))!==row.basis||!includeDevelopment&&!activityOutcome(task).growthEvidence)return false;
    const events=this.eventEvidence(agent,task);
    if(events.development&&!includeDevelopment)return false;
    if(row.data.eventEvidence){
      const saved=row.data.eventEvidence,ids=[...new Set(task.checkpoint?.pluginEventIds??[])];
      if(saved.length!==ids.length||ids.some(id=>!saved.some(ref=>ref.id===id))||events.refs.some(ref=>!saved.some(old=>hash(old)===hash(ref))))return false;
      // The short-lived delivery queue may be pruned normally. Keep the
      // immutable receipt provenance; absence is not an explicit withdrawal.
    }else if(!events.complete)return false; // Legacy origin cannot be recovered.
    if(!row.data.sourceVersions.every(ref=>this.domain.sourceUsable(agent,ref.id)&&this.db.prepare('SELECT hash FROM source_record WHERE agent=? AND id=?').get(agent,ref.id)?.hash===ref.hash))return false;
    if(row.source&&(!this.domain.sourceUsable(agent,row.source)||!this.db.prepare("SELECT 1 FROM memory_record WHERE agent=? AND id=? AND status='active' AND (valid_to IS NULL OR valid_to>?)").get(agent,row.memory,this.clock())))return false;
    const result=task.checkpoint.behaviorResult;
    if(result?.jobId){try{const job=this.tools?.get(agent,result.jobId);if(!job||job.taskId!==task.id||result.status==='completed'&&(job.status!=='completed'||hash(job.result)!==result.resultDigest))return false;}catch{return false;}}
    return true;
  }
  recent(agent,{limit=8,includeDevelopment=false}={}){
    this.journal.assertAdmitted(agent);if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('INVALID_EXPERIENCE_QUERY');
    const rows=[];for(const raw of this.db.prepare('SELECT * FROM human_experience WHERE agent=? ORDER BY created DESC,id DESC').iterate(agent)){const row={...raw,data:parse(raw.data)};if(this.valid(agent,row,{includeDevelopment}))rows.push(row);if(rows.length===limit)break;}return rows;
  }
  sourceEvidence(agent,sourceId){const row=this.db.prepare('SELECT id FROM human_experience WHERE agent=? AND source=?').get(agent,sourceId);if(!row)return null;const experience=this.get(agent,row.id);return this.valid(agent,experience)?experience:null;}
  reflect(agent,{requestId,experienceIds,lesson,nextApproach,role=null}){
    this.journal.assertAdmitted(agent);
    if(typeof requestId!=='string'||requestId.length>160||!Array.isArray(experienceIds)||!experienceIds.length||experienceIds.length>8||new Set(experienceIds).size!==experienceIds.length||[lesson,nextApproach].some(t=>typeof t!=='string'||!t.trim()||t.length>400||secret(t)))throw Error('INVALID_EXPERIENCE_REFLECTION');
    const evidence=experienceIds.map(id=>this.get(agent,id));if(evidence.some(row=>!this.valid(agent,row)))throw Error('INVALID_EXPERIENCE_EVIDENCE');
    const now=this.clock();if(role!==null&&(typeof role!=='object'||Object.keys(role).some(k=>!['label','purpose','expiresAt'].includes(k))||[role.label,role.purpose].some(t=>typeof t!=='string'||!t.trim()||t.length>200||secret(t))||!Number.isSafeInteger(role.expiresAt)||role.expiresAt<=now||role.expiresAt>now+30*86400000))throw Error('INVALID_PHASE_ROLE');
    const data={experienceIds,evidence:evidence.map(row=>({id:row.id,basis:row.basis})),lesson,nextApproach,role,inference:true,authorityChanged:false,ownerPreference:false};
    const old=this.db.prepare('SELECT * FROM human_experience_reflection WHERE agent=? AND request=?').get(agent,requestId);if(old){if(hash(parse(old.data))!==hash(data))throw Error('REQUEST_ID_CONFLICT');return {...old,data:parse(old.data)};}
    const id=randomUUID();this.db.prepare('INSERT INTO human_experience_reflection VALUES(?,?,?,?,?)').run(id,agent,requestId,JSON.stringify(data),now);
    this.journal.audit(agent,'experience-reflected',{reflectionId:id,experienceIds,phaseRole:role?.label??null});return {id,agent,data,created:now};
  }
  reflectionValid(agent,row,get=id=>this.get(agent,id)){return !!row&&row.agent===agent&&!this.journal.value(agent,'experience-reflection-withdrawn:'+row.id,false)&&row.data.evidence.every(ref=>{const e=get(ref.id);return this.valid(agent,e)&&e.basis===ref.basis;});}
  reflection(agent,id){if(typeof id!=='string')return null;const raw=this.db.prepare('SELECT * FROM human_experience_reflection WHERE agent=? AND id=?').get(agent,id),row=raw?{...raw,data:parse(raw.data)}:null;return this.reflectionValid(agent,row)?row:null;}
  hasReflection(agent,experienceId){return this.db.prepare("SELECT id FROM human_experience_reflection WHERE agent=? AND EXISTS(SELECT 1 FROM json_each(human_experience_reflection.data,'$.experienceIds') WHERE value=?)").all(agent,experienceId).some(row=>!!this.reflection(agent,row.id));}
  reflections(agent){const rows=[];for(const raw of this.db.prepare('SELECT * FROM human_experience_reflection WHERE agent=? ORDER BY created DESC,id DESC').iterate(agent)){const row={...raw,data:parse(raw.data)};if(this.reflectionValid(agent,row))rows.push(row);if(rows.length===32)break;}return rows;}
  withdraw(agent,id){this.journal.assertAdmitted(agent);if(!this.db.prepare('SELECT 1 FROM human_experience_reflection WHERE agent=? AND id=?').get(agent,id))throw Error('EXPERIENCE_REFLECTION_NOT_FOUND');this.journal.put(agent,'experience-reflection-withdrawn:'+id,true);this.journal.audit(agent,'experience-reflection-withdrawn',{reflectionId:id});}
  export(agent){this.journal.assertAdmitted(agent);const rows=this.db.prepare('SELECT * FROM human_experience WHERE agent=? ORDER BY created,id').all(agent).map(row=>({...row,data:parse(row.data)}));return {experiences:rows.map(row=>this.valid(agent,row,{includeDevelopment:true})?row:{id:row.id,task:row.task,created:row.created,invalid:true,redacted:true}),reflections:this.reflections(agent),strategyApplications:this.strategies.export(agent),scope:'Execution receipts and active inferred reflections; invalidated derived text omitted.'};}
  context(agent,focus={}){
    this.journal.assertAdmitted(agent);
    const {experiences,reflections,phaseRole,retrieval}=recallExperience(this,agent,focus),group=new Map();
    for(const e of experiences){const key=e.data.receipt.behaviorId??e.data.receipt.kind,row=group.get(key)??{behavior:key,completed:0,failed:0,cancelled:0};row[e.data.receipt.status]++;group.set(key,row);}
    return {experiences:experiences.map(row=>({id:row.id,at:row.created,...row.data.receipt,ownerSatisfaction:'unknown'})),strategyHints:reflections.map(row=>({id:row.id,basis:strategyBasis(row),lesson:row.data.lesson,nextApproach:row.data.nextApproach,inference:true,experienceIds:row.data.experienceIds,applications:this.strategies.summary(agent,row.id)})),recentOutcomes:[...group.values()],phaseRole,retrieval,scope:'Actual digital outcomes and reversible interpretations; no owner facts, physical experience, automatic retry permission, or proof of competence. Application counts and execution success are not causal evidence of strategy improvement.'};
  }
}

export function registerExperienceBehavior(factory){
  if(factory.config?.externalBehaviorIds?.includes('reflect-experience'))return ()=>{};
  return factory.behaviors.register('reflect-experience',createExperienceBehavior(agent=>experienceService(factory,agent.id)));
}
