import {createHash,randomUUID} from 'node:crypto';
import {currentPersonaProfile,DEFAULT_PERSONA_CORE} from './persona-profile.mjs';

const DAY=86400000;
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const text=(value,max,required=false)=>typeof value==='string'&&value.trim().length<=max&&(!required||value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)&&!secret(value)?value.trim():fail('INVALID_MATTER');
const ident=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max?value:fail('INVALID_MATTER');
const actors=new Set(['owner','agent','system']);
const terminal=new Set(['completed','dropped']);
const taskTerminal=new Set(['completed','failed','cancelled']);
export const cognitionPolicy=Object.freeze({version:1,statuses:['inbox','watching','paused','completed','dropped','blocked'],kinds:['research','conversation','question','goal','commitment','other'],activeLimit:128,historyLimit:100,decisionLimit:512,taskLinkLimit:8,defaultCooldownMs:3600000,maxFocusLeaseMs:3600000,sourceKinds:['owner-config','agent-inference','runtime-fact']});
const linkTypes=Object.freeze({task:'autonomy_task',goal:'goal_record',memory:'memory_record',action:'human_action',source:'source_record',note:'learning_note',tool:'human_tool_job'});
const transitions=Object.freeze({watch:'watching',pause:'paused',complete:'completed',drop:'dropped',block:'blocked',reopen:'inbox'});

// These records describe software state and explicit intentions. They are not
// evidence of subjective experience, a second identity, or new permissions.
// The existing driver remains the only executor and model caller.
export class CognitionStore {
  constructor(journal,domain,{factory=null,clock=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.factory=factory;this.clock=clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_matter(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,origin TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(agent,request_id));
      CREATE INDEX IF NOT EXISTS human_matter_agent ON human_matter(agent,status,updated);
      CREATE TABLE IF NOT EXISTS human_matter_revision(agent TEXT NOT NULL,matter TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,changed INTEGER NOT NULL,PRIMARY KEY(agent,matter,version));
      CREATE TABLE IF NOT EXISTS human_matter_request(agent TEXT NOT NULL,request_id TEXT NOT NULL,matter TEXT NOT NULL,request_hash TEXT NOT NULL,result_version INTEGER NOT NULL,PRIMARY KEY(agent,request_id));
      CREATE TABLE IF NOT EXISTS human_attention(agent TEXT PRIMARY KEY,version INTEGER NOT NULL,matter TEXT,task TEXT,decision TEXT,selected INTEGER,lease_until INTEGER,reason TEXT);
      CREATE TABLE IF NOT EXISTS human_cognition_decision(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(agent,request_id));
      CREATE TABLE IF NOT EXISTS human_reflection(id TEXT PRIMARY KEY,agent TEXT NOT NULL,task TEXT NOT NULL,basis TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(agent,task,basis));
      CREATE TABLE IF NOT EXISTS human_reflection_review(agent TEXT NOT NULL,reflection TEXT NOT NULL,matter TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(agent,reflection));
      CREATE INDEX IF NOT EXISTS human_reflection_agent ON human_reflection(agent,created);`);
  }
  admitted(agent){if(!ident(agent))fail('INVALID_COGNITION_SESSION');this.journal.assertAdmitted(agent);if(!this.journal.get(agent))fail('COGNITION_SESSION_NOT_FOUND');}
  now(agent){const time=this.clock();return Math.max(Number.isSafeInteger(time)&&time>=0?time:0,this.journal.value(agent,'cognitionTimeHighWater',0));}
  checkpoint(agent){const now=this.now(agent);this.journal.put(agent,'cognitionTimeHighWater',now);return now;}
  revision(agent){this.admitted(agent);return this.db.prepare('SELECT COALESCE(sum(version),0) n FROM human_matter WHERE agent=?').get(agent).n+this.attentionState(agent).version+this.db.prepare('SELECT count(*) n FROM human_reflection WHERE agent=?').get(agent).n+this.db.prepare('SELECT COALESCE(sum(version),0) n FROM human_reflection_review WHERE agent=?').get(agent).n+this.db.prepare('SELECT COALESCE(max(rowid),0) n FROM human_cognition_decision WHERE agent=?').get(agent).n;}
  selectionRevision(agent){
    this.admitted(agent);
    // Focus leases, task outcome reviews and mechanically generated task cards
    // are runtime activity, not a new owner direction. They must not invalidate
    // an otherwise resumable plan after every foreground interruption.
    return hash(this.db.prepare("SELECT id,version FROM human_matter WHERE agent=? AND request_id NOT LIKE 'autonomy-task:%' ORDER BY id").all(agent));
  }
  table(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  actor(actor){if(!actors.has(actor))fail('INVALID_MATTER_ACTOR');return actor;}
  raw(agent,id){this.admitted(agent);if(!ident(id))fail('MATTER_NOT_FOUND');const row=this.db.prepare('SELECT * FROM human_matter WHERE agent=? AND id=?').get(agent,id);if(!row)fail('MATTER_NOT_FOUND');return {...row,...parse(row.data)};}
  source(actor){return actor==='owner'?'owner-config':actor==='agent'?'agent-inference':'runtime-fact';}
  validateLinks(agent,links){
    if(!Array.isArray(links)||links.length>24||links.some(ref=>!plain(ref)||Object.keys(ref).some(k=>!['type','id'].includes(k))||!ident(ref.id)||!Object.hasOwn(linkTypes,ref.type)&&ref.type!=='topic'))fail('INVALID_MATTER_LINK');
    if(new Set(links.map(ref=>ref.type+':'+ref.id)).size!==links.length)fail('INVALID_MATTER_LINK');
    for(const ref of links){const state=this.linkState(agent,ref);if(!state.exists&&!(ref.type==='task'&&state.archived))fail('MATTER_LINK_NOT_FOUND');}
    return links.map(ref=>({type:ref.type,id:ref.id}));
  }
  linkState(agent,ref){
    if(ref.type==='topic'){
      const stored=this.journal.value(agent,'socialTopicMemory',null)?.records??[],legacy=this.journal.value(agent,'socialContacts',[]),row=[...stored,...legacy].find(r=>r.messageId===ref.id);
      const valid=!!row&&(!row.ownerAnchor||this.sourceValid(agent,row.ownerAnchor))&&row.at>this.journal.value(agent,'memoryContextBarrierAt',0);
      return {type:ref.type,id:ref.id,exists:!!row,valid,status:valid?'recorded':'unavailable'};
    }
    const table=linkTypes[ref.type];if(!table||!this.table(table))return {...ref,exists:false,valid:false,status:'missing'};
    const row=this.db.prepare('SELECT * FROM '+table+' WHERE agent=? AND id=?').get(agent,ref.id);
    if(!row){
      // A retained association can outlive the bounded execution-task table.
      // It is historical provenance, never a source supporting a knowledge claim.
      const archived=ref.type==='task'&&this.knownTaskAssociation(agent,ref.id);
      return {...ref,exists:false,valid:archived,status:archived?'archived':'missing',...(ref.type==='task'?{archived,recordAvailable:false,validityScope:'execution-association-only'}:{})};
    }
    let valid=!['deleted','invalid','superseded','expired'].includes(row.status);
    if(ref.type==='source')valid=this.sourceValid(agent,ref.id);
    if(ref.type==='memory')valid=row.status==='active'&&(row.valid_to===null||row.valid_to>this.now(agent))&&(parse(row.refs)??[]).every(id=>this.sourceValid(agent,id));
    if(ref.type==='note')valid=row.status==='active'&&this.sourceValid(agent,row.source_id)&&this.linkState(agent,{type:'memory',id:row.memory_id}).valid;
    if(ref.type==='goal')valid=(parse(row.refs)??[]).every(id=>this.sourceValid(agent,id))&&row.expires>this.now(agent)&&!['cancelled','expired'].includes(row.status);
    return {...ref,exists:true,valid,status:row.status??'recorded',...(ref.type==='task'?{archived:false,recordAvailable:true,validityScope:'execution-association-only'}:{})};
  }
  sourceValid(agent,id){
    if(!this.table('source_record'))return false;
    const row=this.db.prepare("SELECT namespace,status FROM source_record WHERE agent=? AND id=?").get(agent,id);
    return row?.status==='active'&&row.namespace==='real'&&this.domain.sourceUsable(agent,id);
  }
  checked(agent,input,base={}){
    if(!plain(input)||Object.keys(input).some(k=>!['requestId','expectedVersion','title','description','reason','why','expectedOutcome','stopCondition','nextAction','priority','dueAt','reviewAt','cooldownMs','links','refs','goalId','taskId','tags','kind'].includes(k)))fail('INVALID_MATTER');
    if(input.reason!==undefined&&input.why!==undefined&&input.reason!==input.why||input.links!==undefined&&input.refs!==undefined&&hash(input.links)!==hash(input.refs))fail('INVALID_MATTER');
    const links=[...(input.links??input.refs??base.links??[])];
    for(const [key,type] of [['goalId','goal'],['taskId','task']])if(input[key]!==undefined&&input[key]!==null){if(!ident(input[key]))fail('INVALID_MATTER_LINK');if(!links.some(ref=>ref.type===type&&ref.id===input[key]))links.push({type,id:input[key]});}
    const next={title:text(input.title??base.title??'',160,true),description:text(input.description??base.description??'',1200),reason:text(input.reason??input.why??base.reason??'',500),expectedOutcome:text(input.expectedOutcome??base.expectedOutcome??'',500),stopCondition:text(input.stopCondition??base.stopCondition??'',500),nextAction:text(input.nextAction??base.nextAction??'',500),priority:integer(input.priority??base.priority??50,0,100),dueAt:input.dueAt===undefined?base.dueAt??null:input.dueAt,reviewAt:input.reviewAt===undefined?base.reviewAt??null:input.reviewAt,cooldownMs:integer(input.cooldownMs??base.cooldownMs??cognitionPolicy.defaultCooldownMs,600000,30*DAY),kind:input.kind??base.kind??'other',links:this.validateLinks(agent,links),tags:input.tags??base.tags??[]};
    if(!cognitionPolicy.kinds.includes(next.kind)||[next.dueAt,next.reviewAt].some(at=>at!==null&&(!Number.isSafeInteger(at)||at<0||at>this.now(agent)+366*DAY))||!Array.isArray(next.tags)||next.tags.length>8||next.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>32||secret(tag))||new Set(next.tags).size!==next.tags.length)fail('INVALID_MATTER');
    next.tags=next.tags.map(tag=>tag.trim());return next;
  }
  public(row){const {data,request_hash,...result}=row;return result;}
  getMatter(agent,id){const row=this.raw(agent,id),links=row.links.map(ref=>this.linkState(agent,ref));return {...this.public(row),why:row.reason,links,refs:links,goalId:links.find(ref=>ref.type==='goal')?.id??null,taskId:links.findLast(ref=>ref.type==='task')?.id??null,source:{kind:this.source(row.origin),actor:row.origin,confirmed:row.origin==='owner'},sourceKind:this.source(row.origin),proposal:row.origin==='agent',attentionReady:row.status==='watching'&&!!row.reason&&!!row.expectedOutcome&&!!row.stopCondition&&links.every(ref=>ref.valid)};}
  createMatter(agent,input,{actor='owner'}={}){
    this.admitted(agent);this.actor(actor);if(!ident(input?.requestId)||input.requestId.length<8)fail('INVALID_MATTER_REQUEST');const data=this.checked(agent,input),requestHash=hash({actor,data}),old=this.db.prepare('SELECT id,request_hash FROM human_matter WHERE agent=? AND request_id=?').get(agent,input.requestId);
    if(old){if(old.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return this.getMatter(agent,old.id);}
    if(this.db.prepare("SELECT count(*) n FROM human_matter WHERE agent=? AND status NOT IN ('completed','dropped')").get(agent).n>=cognitionPolicy.activeLimit)fail('MATTER_LIMIT');
    if(actor==='system'&&data.links.length===0)fail('RUNTIME_MATTER_REQUIRES_EVIDENCE');
    const id=randomUUID();this.journal.transaction(()=>{const now=this.checkpoint(agent);this.db.prepare("INSERT INTO human_matter VALUES(?,?,?,?,'inbox',?,1,?,?,?)").run(id,agent,input.requestId,requestHash,actor,JSON.stringify(data),now,now);this.saveRevision(this.raw(agent,id),actor,'created');this.journal.audit(agent,'matter-created',{matterId:id,version:1,actor,sourceKind:this.source(actor),kind:data.kind,linked:data.links});});return this.getMatter(agent,id);
  }
  saveRevision(row,actor,reason){this.db.prepare('INSERT INTO human_matter_revision VALUES(?,?,?,?,?,?,?)').run(row.agent,row.id,row.version,JSON.stringify(this.public(row)),actor,reason,row.updated);}
  request(agent,id,input,actor,action){
    if(!plain(input)||!ident(input.requestId)||input.requestId.length<8)fail('INVALID_MATTER_REQUEST');
    const requestHash=hash({id,actor,action,input}),old=this.db.prepare('SELECT * FROM human_matter_request WHERE agent=? AND request_id=?').get(agent,input.requestId);
    if(old){if(old.matter!==id||old.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return {replayed:true,result:this.getMatter(agent,id),hash:requestHash};}
    return {replayed:false,hash:requestHash};
  }
  saveChange(row,data,status,{actor,reason,requestId,requestHash}){
    const now=this.checkpoint(row.agent),result=this.db.prepare('UPDATE human_matter SET status=?,data=?,version=version+1,updated=? WHERE agent=? AND id=? AND version=?').run(status,JSON.stringify(data),now,row.agent,row.id,row.version);if(result.changes!==1)fail('STALE_MATTER');
    const next=this.raw(row.agent,row.id);this.saveRevision(next,actor,reason);this.db.prepare('INSERT INTO human_matter_request VALUES(?,?,?,?,?)').run(row.agent,requestId,row.id,requestHash,next.version);this.journal.audit(row.agent,'matter-updated',{matterId:row.id,fromVersion:row.version,version:next.version,actor,action:reason,priorStatus:row.status,status});
    if(terminal.has(status)&&this.journal.value(row.agent,'cognitionPreferredMatter',null)?.matterId===row.id)this.journal.put(row.agent,'cognitionPreferredMatter',null);
    const focus=this.attentionState(row.agent);if(focus.matterId===row.id&&(focus.taskId&&status!=='watching'||terminal.has(status)))this.clearFocus(row.agent,'matter-'+status);
  }
  reviseMatter(agent,id,input,{actor='owner'}={}){
    this.admitted(agent);this.actor(actor);const request=this.request(agent,id,input,actor,'revise');if(request.replayed)return request.result;
    const row=this.raw(agent,id);if(row.version!==input.expectedVersion)fail('STALE_MATTER');if(actor==='agent'&&row.origin==='owner')fail('OWNER_MATTER_REVISION_REQUIRES_OWNER');
    const data=this.checked(agent,input,row);if(row.status==='watching'&&(!data.reason||!data.expectedOutcome||!data.stopCondition))fail('MATTER_ATTENTION_CONTRACT_REQUIRED');
    this.journal.transaction(()=>this.saveChange(row,data,row.status,{actor,reason:'revised',requestId:input.requestId,requestHash:request.hash}));return this.getMatter(agent,id);
  }
  transitionMatter(agent,id,action,input={},options={}){
    const actor=this.actor(options.actor??'owner');this.admitted(agent);if(!Object.hasOwn(transitions,action)||!plain(input)||Object.keys(input).some(k=>!['requestId','expectedVersion','reason'].includes(k)))fail('INVALID_MATTER_ACTION');
    const request=this.request(agent,id,input,actor,action);if(request.replayed)return request.result;const row=this.raw(agent,id);if(row.version!==input.expectedVersion)fail('STALE_MATTER');
    if(terminal.has(row.status)&&action!=='reopen'||!terminal.has(row.status)&&action==='reopen'&&row.status!=='blocked'&&row.status!=='paused')fail('INVALID_MATTER_TRANSITION');
    const reason=text(input.reason??action,500,true);if(actor==='agent'&&row.origin==='owner'&&['complete','drop'].includes(action))fail('OWNER_MATTER_CLOSURE_REQUIRES_OWNER');
    if(action==='watch'&&(!row.reason||!row.expectedOutcome||!row.stopCondition||!row.links.every(ref=>this.linkState(agent,ref).valid)))fail('MATTER_ATTENTION_CONTRACT_REQUIRED');
    if(action==='reopen'&&terminal.has(row.status)&&this.db.prepare("SELECT count(*) n FROM human_matter WHERE agent=? AND status NOT IN ('completed','dropped')").get(agent).n>=cognitionPolicy.activeLimit)fail('MATTER_LIMIT');
    const data=this.checked(agent,{},row);this.journal.transaction(()=>this.saveChange(row,data,transitions[action],{actor,reason:action+':'+reason,requestId:input.requestId,requestHash:request.hash}));return this.getMatter(agent,id);
  }
  listMatters(agent,{status='',origin='',query='',limit=50,offset=0}={}){
    this.admitted(agent);integer(limit,1,100);integer(offset,0,100000);query=text(query,128).toLowerCase();if(status&&!cognitionPolicy.statuses.includes(status)||origin&&!actors.has(origin))fail('INVALID_MATTER_QUERY');
    const where='agent=?'+(status?' AND status=?':'')+(origin?' AND origin=?':'')+(query?' AND (lower(json_extract(data,\'$.title\')) LIKE ? ESCAPE \'\\\' OR lower(json_extract(data,\'$.description\')) LIKE ? ESCAPE \'\\\')':''),escaped=query.replace(/[\\%_]/g,'\\$&'),params=[agent,...(status?[status]:[]),...(origin?[origin]:[]),...(query?['%'+escaped+'%','%'+escaped+'%']:[])];
    const total=this.db.prepare('SELECT count(*) n FROM human_matter WHERE '+where).get(...params).n,rows=this.db.prepare('SELECT id FROM human_matter WHERE '+where+" ORDER BY CASE WHEN status='watching' THEN 0 WHEN status='inbox' THEN 1 WHEN status='blocked' THEN 2 WHEN status='paused' THEN 3 ELSE 4 END,updated DESC,id LIMIT ? OFFSET ?").all(...params,limit,offset);
    return {items:rows.map(row=>this.getMatter(agent,row.id)),total,offset,limit,hasMore:offset+rows.length<total};
  }
  history(agent,id){this.raw(agent,id);const rows=this.db.prepare('SELECT version,data,actor,reason,changed FROM human_matter_revision WHERE agent=? AND matter=? ORDER BY version DESC LIMIT ?').all(agent,id,cognitionPolicy.historyLimit);return {matterId:id,items:rows.map(row=>({...row,data:parse(row.data)})),limit:cognitionPolicy.historyLimit,truncated:rows.length===cognitionPolicy.historyLimit&&rows.at(-1).version>1};}
  knownTaskAssociation(agent,taskId){
    if(this.db.prepare("SELECT 1 FROM human_matter m WHERE m.agent=? AND EXISTS(SELECT 1 FROM json_each(m.data,'$.links') ref WHERE json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=?) LIMIT 1").get(agent,taskId))return true;
    if(this.db.prepare("SELECT 1 FROM human_matter_revision r WHERE r.agent=? AND EXISTS(SELECT 1 FROM json_each(r.data,'$.links') ref WHERE json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=?) LIMIT 1").get(agent,taskId))return true;
    return !!this.db.prepare('SELECT 1 FROM human_reflection WHERE agent=? AND task=? LIMIT 1').get(agent,taskId);
  }
  taskLinkedToMatter(agent,matterId,taskId){
    const matter=this.raw(agent,matterId);if(matter.links.some(ref=>ref.type==='task'&&ref.id===taskId))return true;
    if(this.table('autonomy_task')&&this.db.prepare("SELECT 1 FROM autonomy_task WHERE agent=? AND id=? AND json_extract(checkpoint,'$.matterId')=?").get(agent,taskId,matterId))return true;
    if(this.db.prepare("SELECT 1 FROM human_reflection WHERE agent=? AND task=? AND json_extract(data,'$.evidence.task.matterId')=? LIMIT 1").get(agent,taskId,matterId))return true;
    return !!this.db.prepare("SELECT 1 FROM human_matter_revision r WHERE r.agent=? AND r.matter=? AND EXISTS(SELECT 1 FROM json_each(r.data,'$.links') ref WHERE json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=?) LIMIT 1").get(agent,matterId,taskId);
  }
  matterForTask(agent,taskId){
    this.admitted(agent);if(!ident(taskId))fail('TASK_NOT_FOUND');
    const taskCheckpoint=this.table('autonomy_task')?this.db.prepare('SELECT checkpoint FROM autonomy_task WHERE agent=? AND id=?').get(agent,taskId):null;
    const checkpointMatterId=parse(taskCheckpoint?.checkpoint)?.matterId;
    if(ident(checkpointMatterId)&&this.db.prepare('SELECT 1 FROM human_matter WHERE agent=? AND id=?').get(agent,checkpointMatterId))return this.getMatter(agent,checkpointMatterId);
    const row=this.db.prepare("SELECT m.id FROM human_matter m WHERE m.agent=? AND (EXISTS(SELECT 1 FROM json_each(m.data,'$.links') ref WHERE json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=?) OR EXISTS(SELECT 1 FROM human_reflection f WHERE f.agent=m.agent AND f.task=? AND json_extract(f.data,'$.evidence.task.matterId')=m.id) OR EXISTS(SELECT 1 FROM human_matter_revision r WHERE r.agent=m.agent AND r.matter=m.id AND EXISTS(SELECT 1 FROM json_each(r.data,'$.links') ref WHERE json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=?))) ORDER BY CASE WHEN m.origin='owner' THEN 0 ELSE 1 END,CASE WHEN m.status='watching' THEN 0 ELSE 1 END,m.updated DESC,m.id LIMIT 1").get(agent,taskId,taskId,taskId);
    return row?this.getMatter(agent,row.id):null;
  }
  findMatterForTask(agent,taskId){return this.matterForTask(agent,taskId);}
  contextMatters(agent,{limit=3}={}){
    this.admitted(agent);integer(limit,1,8);const now=this.now(agent),focus=this.attentionState(agent),rows=this.db.prepare("SELECT id FROM human_matter WHERE agent=? AND status NOT IN ('completed','dropped') ORDER BY created,id LIMIT ?").all(agent,cognitionPolicy.activeLimit),items=rows.map(row=>this.getMatter(agent,row.id));
    if(focus.matterId&&!items.some(item=>item.id===focus.matterId))try{const item=this.getMatter(agent,focus.matterId);if(!terminal.has(item.status))items.push(item);}catch{/* A missing focus remains an unknown reference, not fabricated content. */}
    const score=item=>item.priority+Math.min(20,Math.floor(Math.max(0,now-item.created)/DAY))+(item.dueAt!==null?(item.dueAt<=now?25:item.dueAt-now<=DAY?15:0):0)+(item.origin==='owner'?10:0);
    // UI history retains withdrawn records with their invalid reference flags.
    // Model context must not receive their old descriptions or inferences.
    return items.filter(item=>item.refs.every(ref=>ref.valid===true)).sort((a,b)=>Number(b.id===focus.matterId)-Number(a.id===focus.matterId)||score(b)-score(a)||a.created-b.created||a.id.localeCompare(b.id)).slice(0,limit);
  }
  preferredMatter(agent){
    const value=this.journal.value(agent,'cognitionPreferredMatter',null);if(!plain(value)||!ident(value.matterId)||typeof value.reason!=='string'||value.reason.length>500||secret(value.reason)||!Number.isSafeInteger(value.at)||value.at<0)return null;
    const row=this.db.prepare('SELECT status FROM human_matter WHERE agent=? AND id=?').get(agent,value.matterId);return row&&!terminal.has(row.status)?{matterId:value.matterId,reason:value.reason,at:value.at}:null;
  }
  attentionState(agent){this.admitted(agent);const row=this.db.prepare('SELECT * FROM human_attention WHERE agent=?').get(agent),preferred=this.preferredMatter(agent),state=row?{version:row.version,matterId:row.matter,taskId:row.task,decisionId:row.decision,selectedAt:row.selected,leaseUntil:row.lease_until,reason:row.reason}:{version:0,matterId:null,taskId:null,decisionId:null,selectedAt:null,leaseUntil:null,reason:null};return {...state,focusId:state.matterId,focusedTaskId:state.taskId,preferredMatterId:preferred?.matterId??null,preferredReason:preferred?.reason??null,preferredAt:preferred?.at??null,basis:'persisted-single-focus-with-bounded-lease; owner-preference-is-not-execution-authority'};}
  gates(agent,{ownerPending=false,budgetAllowed=null,now=this.now(agent)}={}){
    const control=this.journal.get(agent),batch=this.journal.value(agent,'ownerBatch',null),executing=this.table('autonomy_task')?this.db.prepare("SELECT id FROM autonomy_task WHERE agent=? AND status='executing' LIMIT 1").get(agent):null;
    const reasons=[];if(ownerPending===true||batch&&!batch.failed&&!batch.invalidated)reasons.push('owner-priority');if(control?.desired!=='running')reasons.push('driver-paused');if(this.journal.value(agent,'autonomyPaused',false))reasons.push('autonomy-paused');if(this.journal.value(agent,'autonomyError',null))reasons.push('autonomy-error');if(this.journal.value(agent,'autonomyBudgetRequest',null)||budgetAllowed===false)reasons.push('budget-wait');if(executing)reasons.push('task-running');
    return {allowed:reasons.length===0,reasons,ownerPriority:reasons.includes('owner-priority'),budgetVerified:budgetAllowed===true,now,executingTaskId:executing?.id??null,scope:'Advisory deterministic gates. Existing signed quota, execution and publication checks remain mandatory.'};
  }
  attentionCandidates(agent,input={}){
    this.admitted(agent);const now=input.now??this.now(agent);if(!Number.isSafeInteger(now)||now<0)fail('INVALID_ATTENTION_TIME');const gate=this.gates(agent,{...input,now});
    const rows=this.db.prepare("SELECT id FROM human_matter WHERE agent=? AND status='watching' ORDER BY created,id LIMIT ?").all(agent,cognitionPolicy.activeLimit),eligible=[],held=[];
    for(const {id} of rows){const item=this.getMatter(agent,id),last=this.db.prepare("SELECT max(created) at FROM human_cognition_decision WHERE agent=? AND json_extract(data,'$.matterId')=? AND json_extract(data,'$.decision')='focus'").get(agent,id)?.at??0,latest=this.latestReflectionForMatter(agent,item),reasons=[];
      const resumeTask=input.resumeTaskId&&this.taskLinkedToMatter(agent,item.id,input.resumeTaskId)?this.db.prepare("SELECT id FROM autonomy_task WHERE agent=? AND id=? AND status IN ('ready','suspended','waiting-budget')").get(agent,input.resumeTaskId):null,resuming=!!resumeTask&&!!this.db.prepare("SELECT 1 FROM human_cognition_decision WHERE agent=? AND json_extract(data,'$.matterId')=? AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.decision')='focus' LIMIT 1").get(agent,id,input.resumeTaskId);
      if(!item.attentionReady)reasons.push('evidence-or-contract-unavailable');if(last&&last+item.cooldownMs>now&&!resuming)reasons.push('cooldown');if(item.reviewAt!==null&&item.reviewAt>now)reasons.push('review-not-due');if(latest?.recommendation?.action==='stop-and-review'&&!latest.review)reasons.push('reflection-review-required');
      const age=Math.min(20,Math.floor(Math.max(0,now-item.created)/DAY)),due=item.dueAt===null?0:item.dueAt<=now?25:item.dueAt-now<=DAY?15:0,owner=item.origin==='owner'?10:0,score=item.priority+age+due+owner;
      const candidate={matterId:item.id,title:item.title,kind:item.kind,priority:item.priority,score,scoreParts:{priority:item.priority,age,due,owner},reason:item.reason,why:item.reason,expectedOutcome:item.expectedOutcome,stopCondition:item.stopCondition,nextAction:item.nextAction,links:item.links,refs:item.links,origin:item.origin,sourceKind:item.sourceKind,nextEligibleAt:Math.max(last?last+item.cooldownMs:0,item.reviewAt??0)||null,reflection:latest?{id:latest.id,recommendation:latest.recommendation,suggestion:latest.suggestion,review:latest.review}:null};
      if(reasons.length)held.push({...candidate,reasons});else eligible.push(candidate);
    }
    eligible.sort((a,b)=>b.score-a.score||a.matterId.localeCompare(b.matterId));
    const state=this.attentionState(agent);return {...state,at:now,method:'deterministic-priority-age-deadline-owner-v1',gates:gate,focus:state,candidates:eligible.slice(0,integer(input.candidateLimit??8,1,cognitionPolicy.activeLimit)),held:held.slice(0,12),totalEligible:eligible.length,totalHeld:held.length,selected:gate.allowed?eligible[0]??null:null,proposalOnly:true};
  }
  recordDecision(agent,input){
    this.admitted(agent);if(!plain(input)||!ident(input.requestId)||input.requestId.length<8||!['focus','manual-focus','manual-release','wait','yield','release'].includes(input.decision))fail('INVALID_ATTENTION_DECISION');
    const matterId=input.matterId??null,taskId=input.taskId??null;if(matterId)this.raw(agent,matterId);if(taskId&&!this.linkState(agent,{type:'task',id:taskId}).exists)fail('TASK_NOT_FOUND');
    const data={decision:input.decision,matterId,taskId,reason:text(input.reason??'',500,true),basis:input.basis??null};if(data.basis!==null&&(!plain(data.basis)||Buffer.byteLength(JSON.stringify(data.basis))>4000||secret(JSON.stringify(data.basis))))fail('INVALID_ATTENTION_BASIS');
    const requestHash=hash(data),old=this.db.prepare('SELECT * FROM human_cognition_decision WHERE agent=? AND request_id=?').get(agent,input.requestId);if(old){if(old.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return {id:old.id,created:old.created,...parse(old.data)};}
    const id=randomUUID(),created=this.checkpoint(agent);this.db.prepare('INSERT INTO human_cognition_decision VALUES(?,?,?,?,?,?)').run(id,agent,input.requestId,requestHash,JSON.stringify(data),created);this.db.prepare('DELETE FROM human_cognition_decision WHERE agent=? AND id NOT IN (SELECT id FROM human_cognition_decision WHERE agent=? ORDER BY created DESC,id DESC LIMIT ?)').run(agent,agent,cognitionPolicy.decisionLimit);this.journal.audit(agent,'attention-decision',{decisionId:id,...data});return {id,created,...data};
  }
  focus(agent,input={}){
    this.admitted(agent);if(!plain(input)||!ident(input.requestId))fail('INVALID_ATTENTION_DECISION');const prior=this.db.prepare('SELECT data FROM human_cognition_decision WHERE agent=? AND request_id=?').get(agent,input.requestId);if(prior){const saved=parse(prior.data);if(saved?.decision!=='focus'||saved.matterId!==input.matterId||saved.taskId!==(input.taskId??null)||saved.basis?.inputHash!==hash(input))fail('REQUEST_ID_CONFLICT');return this.attentionState(agent);}
    const old=this.attentionState(agent);if(old.version!==input.expectedVersion)fail('STALE_ATTENTION');const item=this.getMatter(agent,input.matterId),gate=this.gates(agent,input);if(!gate.allowed)fail('ATTENTION_GATE_CLOSED');if(!item.attentionReady)fail('MATTER_NOT_ATTENTION_READY');
    if(input.taskId&&!this.taskLinkedToMatter(agent,item.id,input.taskId))fail('ATTENTION_TASK_NOT_LINKED');
    const now=this.now(agent);if(old.matterId&&old.leaseUntil>now&&old.matterId!==item.id)fail('ATTENTION_FOCUS_BUSY');const selection=this.attentionCandidates(agent,{...input,resumeTaskId:input.taskId??null});if(!selection.candidates.some(candidate=>candidate.matterId===item.id))fail('MATTER_NOT_ATTENTION_ELIGIBLE');
    return this.journal.transaction(()=>{const decision=this.recordDecision(agent,{requestId:input.requestId,decision:'focus',matterId:item.id,taskId:input.taskId??null,reason:input.reason??item.reason,basis:{matterVersion:item.version,gateReasons:gate.reasons,method:selection.method,inputHash:hash(input)}});this.db.prepare('INSERT INTO human_attention VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent) DO UPDATE SET version=excluded.version,matter=excluded.matter,task=excluded.task,decision=excluded.decision,selected=excluded.selected,lease_until=excluded.lease_until,reason=excluded.reason').run(agent,old.version+1,item.id,input.taskId??null,decision.id,now,now+integer(input.leaseMs??900000,1000,cognitionPolicy.maxFocusLeaseMs),decision.reason);return this.attentionState(agent);});
  }
  clearFocus(agent,reason='released'){
    const state=this.attentionState(agent),preferred=this.preferredMatter(agent);if(!state.matterId&&!state.taskId&&!preferred)return state;if(preferred&&state.matterId===preferred.matterId&&!state.taskId&&state.leaseUntil===null)return state;
    this.db.prepare('INSERT INTO human_attention VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent) DO UPDATE SET version=excluded.version,matter=excluded.matter,task=NULL,decision=NULL,selected=excluded.selected,lease_until=NULL,reason=excluded.reason').run(agent,state.version+1,preferred?.matterId??null,null,null,preferred?.at??null,null,preferred?.reason??text(reason,500,true));this.journal.audit(agent,'attention-released',{matterId:state.matterId,taskId:state.taskId,reason,restoredPreferredMatterId:preferred?.matterId??null,executionRequested:false});return this.attentionState(agent);
  }
  manualFocus(agent,{requestId,matterId,expectedVersion,reason='主人指定关注事项'}={}){
    this.admitted(agent);if(!ident(requestId)||requestId.length<8)fail('INVALID_ATTENTION_DECISION');const item=this.getMatter(agent,matterId),old=this.attentionState(agent),prior=this.db.prepare('SELECT data FROM human_cognition_decision WHERE agent=? AND request_id=?').get(agent,requestId);
    if(prior){const data=parse(prior.data);if(data?.decision!=='manual-focus'||data.matterId!==matterId||data.reason!==text(reason,500,true))fail('REQUEST_ID_CONFLICT');return this.attentionState(agent);}if(terminal.has(item.status))fail('MATTER_CLOSED');if(expectedVersion!==old.version)fail('STALE_ATTENTION');
    return this.journal.transaction(()=>{const decision=this.recordDecision(agent,{requestId,decision:'manual-focus',matterId,reason,basis:{actor:'owner',matterVersion:item.version,executionRequested:false}}),now=this.checkpoint(agent);this.journal.put(agent,'cognitionPreferredMatter',{matterId,reason:decision.reason,at:now});
      // Updating the owner's preference does not replace an executing task or
      // grant that preference permission to run. It is restored at release.
      if(old.taskId)this.db.prepare('UPDATE human_attention SET version=version+1 WHERE agent=?').run(agent);
      else this.db.prepare('INSERT INTO human_attention VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent) DO UPDATE SET version=excluded.version,matter=excluded.matter,task=NULL,decision=excluded.decision,selected=excluded.selected,lease_until=NULL,reason=excluded.reason').run(agent,old.version+1,matterId,null,decision.id,now,null,decision.reason);return this.attentionState(agent);});
  }
  manualRelease(agent,{requestId,expectedVersion,reason='主人清除关注事项'}={}){return this.releaseAttention(agent,{requestId,expectedVersion,reason},true);}
  releaseFocus(agent,{expectedVersion,reason='released',requestId}={}){return this.releaseAttention(agent,{requestId,expectedVersion,reason},false);}
  releaseAttention(agent,{requestId,expectedVersion,reason},manual){
    this.admitted(agent);if(!ident(requestId)||requestId.length<8)fail('INVALID_ATTENTION_DECISION');const current=this.attentionState(agent),decision=manual?'manual-release':'release',inputHash=hash({expectedVersion,reason,manual}),prior=this.db.prepare('SELECT data FROM human_cognition_decision WHERE agent=? AND request_id=?').get(agent,requestId);
    if(prior){const data=parse(prior.data);if(data?.decision!==decision||data.basis?.inputHash!==inputHash)fail('REQUEST_ID_CONFLICT');return current;}if(expectedVersion!==current.version)fail('STALE_ATTENTION');
    return this.journal.transaction(()=>{this.recordDecision(agent,{requestId,decision,matterId:manual?current.preferredMatterId??(current.taskId?null:current.matterId):current.matterId,taskId:manual?null:current.taskId,reason,basis:{actor:manual?'owner':'system',executionRequested:false,inputHash}});if(manual){this.journal.put(agent,'cognitionPreferredMatter',null);if(current.taskId){this.db.prepare('UPDATE human_attention SET version=version+1 WHERE agent=?').run(agent);return this.attentionState(agent);}}return this.clearFocus(agent,reason);});
  }
  latestReflectionForMatter(agent,matter){
    // Current task links are deliberately bounded. Historical revisions and
    // the persisted checkpoint identity retain exact associations after pruning.
    const row=this.db.prepare("SELECT f.* FROM human_reflection f WHERE f.agent=? AND (json_extract(f.data,'$.evidence.task.matterId')=? OR EXISTS(SELECT 1 FROM human_matter m,json_each(m.data,'$.links') ref WHERE m.agent=f.agent AND m.id=? AND json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=f.task) OR EXISTS(SELECT 1 FROM human_matter_revision r,json_each(r.data,'$.links') ref WHERE r.agent=f.agent AND r.matter=? AND json_extract(ref.value,'$.type')='task' AND json_extract(ref.value,'$.id')=f.task)) ORDER BY f.created DESC,f.id DESC LIMIT 1").get(agent,matter.id,matter.id,matter.id);
    return row?this.projectReflection(agent,row):null;
  }
  projectReflection(agent,row){
    const recorded=parse(row.data)??{},evidence=recorded.evidence??{},notes=(evidence.notes??[]).map(note=>{
      const state=this.linkState(agent,{type:'note',id:note.id});
      return {...note,recordedSourceValid:note.sourceValid===true,sourceValid:state.valid===true,currentStatus:state.status};
    });
    const evidenceValidityChanged=notes.some(note=>note.recordedSourceValid!==note.sourceValid);
    // This is a read-only view. The original basis, review and audit remain
    // immutable; deliberate reconciliation can later record a new reflection.
    return {id:row.id,created:row.created,...recorded,evidence:{...evidence,notes},comparison:{...recorded.comparison,validLearningNotes:notes.filter(note=>note.sourceValid).length},evidenceValidityChanged,requiresReevaluation:evidenceValidityChanged,review:this.reflectionReview(agent,row.id)};
  }
  reflectionEvidence(agent,task){
    const checkpoint=parse(task.checkpoint)??{},attempts=this.table('attempt')?this.db.prepare("SELECT id,state,error,usage_confidence,usage,started,ended FROM attempt WHERE agent=? AND json_extract(request,'$.taskId')=? ORDER BY started DESC,id DESC LIMIT 32").all(agent,task.id).reverse().map(row=>({...row,usage:parse(row.usage)})):[],notes=this.table('learning_note')?this.db.prepare("SELECT id,memory_id,source_id,status,feedback FROM learning_note WHERE agent=? AND json_extract(data,'$.taskId')=? ORDER BY created,id LIMIT 8").all(agent,task.id).map(row=>{const feedback=parse(row.feedback);return {id:row.id,status:row.status,sourceValid:this.linkState(agent,{type:'note',id:row.id}).valid,feedback:feedback?{value:feedback.value,time:feedback.time,comment:typeof feedback.comment==='string'&&!secret(feedback.comment)?feedback.comment.slice(0,500):null}:null};}):[],published=this.table('audit')?this.db.prepare("SELECT seq,data FROM audit WHERE agent=? AND kind='response-published' AND json_extract(data,'$.taskId')=? ORDER BY seq LIMIT 8").all(agent,task.id).map(row=>({auditSeq:row.seq,messageId:parse(row.data)?.messageId??null,at:parse(row.data)?.time??null})):[];
    const code=checkpoint.reason??checkpoint.error??attempts.findLast(row=>row.error)?.error??null;
    const matterId=ident(checkpoint.matterId)&&this.db.prepare('SELECT 1 FROM human_matter WHERE agent=? AND id=?').get(agent,checkpoint.matterId)?checkpoint.matterId:null;
    return {task:{id:task.id,kind:task.kind,status:task.status,created:task.created,updated:task.updated,matterId,question:text(String(checkpoint.plan?.question??checkpoint.candidate?.question??'').slice(0,240),240)},reason:typeof code==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/u.test(code)?code:null,attempts:attempts.map(row=>({id:row.id,state:row.state,error:typeof row.error==='string'&&/^[A-Za-z0-9_.:-]{1,120}$/u.test(row.error)?row.error:null,started:row.started,ended:row.ended,usageConfidence:row.usage_confidence,reportedTokens:row.usage_confidence==='reported'&&Number.isFinite(row.usage?.totalTokens)?row.usage.totalTokens:null})),notes,published,scope:'Local execution and publication receipts; not proof of owner satisfaction, phone receipt, correctness or lasting personality change.'};
  }
  reflectTask(agent,taskId){
    this.admitted(agent);if(!ident(taskId)||!this.table('autonomy_task'))fail('TASK_NOT_FOUND');const task=this.db.prepare('SELECT * FROM autonomy_task WHERE agent=? AND id=?').get(agent,taskId);if(!task)fail('TASK_NOT_FOUND');if(!taskTerminal.has(task.status))return null;
    const evidence=this.reflectionEvidence(agent,task),basis=hash(evidence),old=this.db.prepare('SELECT id,data,created FROM human_reflection WHERE agent=? AND task=? AND basis=?').get(agent,taskId,basis);if(old)return this.projectReflection(agent,old);
    const completed=task.status==='completed',validNotes=evidence.notes.filter(note=>note.sourceValid),hadOutput=validNotes.length>0||evidence.published.length>0,repeated=evidence.reason===null?0:this.db.prepare("SELECT count(DISTINCT task) n FROM human_reflection WHERE agent=? AND task<>? AND json_extract(data,'$.evidence.task.kind')=? AND json_extract(data,'$.evidence.reason')=? AND json_extract(data,'$.evidence.task.status')='failed' AND created>=?").get(agent,taskId,task.kind,evidence.reason,this.now(agent)-7*DAY).n;
    let action=completed?'review-result':task.status==='cancelled'?'respect-stop':'change-strategy',reason=completed?'执行记录已完成，真实价值和主人满意度仍需反馈。':task.status==='cancelled'?'记录取消原因；不会自动重试或恢复。':'保留失败证据，下一次需调整方法或由主人决定。';
    if(completed&&!hadOutput){action='verify-outcome';reason='任务标记完成，但本地未找到有效学习笔记或发布记录；不能据此宣称目标达成。';}
    if(!completed&&task.status!=='cancelled'&&/BUDGET|QUOTA|AUTHORIZATION|APPROVAL/u.test(evidence.reason??'')){action='wait-authorisation';reason='先核对预算或权限；反思不会扩大权限、补额或自动重试。';}
    else if(!completed&&task.status!=='cancelled'&&repeated>=2){action='stop-and-review';reason='七天内同类任务已出现至少三次同码失败；建议停止重复方向并核对环境或策略。';}
    // Rule-derived outcome text is a review note, not a newly planned research
    // question. Pause by default so accepting it cannot dispatch that note as
    // the next public search; a future executable step needs explicit planning.
    const suggestion={action:'pause',nextAction:reason,allowedActions:['pause','watch','drop','nextAction'],requiresOwnerReview:true,scope:'Only modifies this board matter. This rule proposes waiting for review, not executable future work. Never retries a failed task, changes permissions, changes personality or dispatches work.'};
    const checkpoint=parse(task.checkpoint)??{},expected=checkpoint.matterContract?.expectedOutcome??checkpoint.plan?.value,expectedText=typeof expected==='string'&&!secret(expected)?expected.slice(0,500):null;
    const data={kind:'rule-derived-outcome-review',evidence,comparison:{expected:expectedText,executionStatus:task.status,validLearningNotes:validNotes.length,localPublishedMessages:evidence.published.length,ownerSatisfaction:'unknown',expectedOutcomeVerified:false},recommendation:{action,reason,inference:true,requiresNewDispatchChecks:true},suggestion,automaticChanges:{persona:false,permissions:false,quota:false,retry:false},basis};
    const id=randomUUID();this.journal.transaction(()=>{const now=this.checkpoint(agent);this.db.prepare('INSERT INTO human_reflection VALUES(?,?,?,?,?,?)').run(id,agent,taskId,basis,JSON.stringify(data),now);this.journal.audit(agent,'result-reflected',{reflectionId:id,taskId,basis,status:task.status,recommendation:action,inference:true});if(this.attentionState(agent).taskId===taskId)this.clearFocus(agent,'task-'+task.status);this.finalizeTaskMatter(agent,task,{basis,hadOutput});});return {id,created:this.now(agent),...data};
  }
  finalizeTaskMatter(agent,task,{basis,hadOutput}){
    const record=this.db.prepare("SELECT id FROM human_matter WHERE agent=? AND request_id=? AND origin='agent'").get(agent,'autonomy-task:'+task.id);if(!record)return;
    // Only close the mechanically created single-task card. A later explicit
    // owner edit, or an owner-authored matter, takes precedence over this rule.
    if(this.db.prepare("SELECT 1 FROM human_matter_revision WHERE agent=? AND matter=? AND actor='owner' LIMIT 1").get(agent,record.id))return;
    const row=this.raw(agent,record.id),status=task.status==='completed'&&hadOutput?'completed':task.status==='cancelled'?'paused':'blocked';if(row.status===status)return;
    const data=this.checked(agent,{},row),requestId='task-outcome:'+basis,requestHash=hash({task:task.id,status,basis});this.saveChange(row,data,status,{actor:'system',reason:'actual-task-outcome:'+task.status,requestId,requestHash});
  }
  reflectionReview(agent,id){const row=this.db.prepare('SELECT matter,version,status,data,updated FROM human_reflection_review WHERE agent=? AND reflection=?').get(agent,id);return row?{matterId:row.matter,version:row.version,status:row.status,updated:row.updated,...parse(row.data)}:null;}
  getReflection(agent,id){this.admitted(agent);if(!ident(id))fail('REFLECTION_NOT_FOUND');const row=this.db.prepare('SELECT id,data,created FROM human_reflection WHERE agent=? AND id=?').get(agent,id);if(!row)fail('REFLECTION_NOT_FOUND');return this.projectReflection(agent,row);}
  reflections(agent,{limit=20,offset=0,taskId=null}={}){this.admitted(agent);integer(limit,1,100);integer(offset,0,100000);if(taskId!==null&&!ident(taskId))fail('INVALID_REFLECTION_QUERY');const args=[agent,...(taskId?[taskId]:[])],where='agent=?'+(taskId?' AND task=?':'');const total=this.db.prepare('SELECT count(*) n FROM human_reflection WHERE '+where).get(...args).n,rows=this.db.prepare('SELECT id,data,created FROM human_reflection WHERE '+where+' ORDER BY created DESC,id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);return {items:rows.map(row=>this.projectReflection(agent,row)),total,offset,limit,hasMore:offset+rows.length<total};}
  decisions(agent,{limit=20,offset=0}={}){this.admitted(agent);integer(limit,1,100);integer(offset,0,100000);const total=this.db.prepare('SELECT count(*) n FROM human_cognition_decision WHERE agent=?').get(agent).n,rows=this.db.prepare('SELECT id,data,created FROM human_cognition_decision WHERE agent=? ORDER BY created DESC,id DESC LIMIT ? OFFSET ?').all(agent,limit,offset);return {items:rows.map(row=>({id:row.id,created:row.created,...parse(row.data)})),total,offset,limit,hasMore:offset+rows.length<total};}
  applyReflectionSuggestion(agent,reflectionId,input={},options={}){
    this.admitted(agent);if((options.actor??'owner')!=='owner')fail('REFLECTION_REVIEW_REQUIRES_OWNER');
    if(!ident(reflectionId)||!plain(input)||Object.keys(input).some(key=>!['requestId','matterId','expectedVersion','expectedReviewVersion','action','suggestionAction','reason'].includes(key))||!['apply','dismiss'].includes(input.action??'apply'))fail('INVALID_REFLECTION_REVIEW');
    const row=this.db.prepare('SELECT * FROM human_reflection WHERE agent=? AND id=?').get(agent,reflectionId);if(!row)fail('REFLECTION_NOT_FOUND');const reflection=parse(row.data),matter=this.raw(agent,input.matterId);if(!this.taskLinkedToMatter(agent,matter.id,row.task))fail('REFLECTION_MATTER_MISMATCH');
    const request=this.request(agent,matter.id,input,'owner','reflection:'+reflectionId);if(request.replayed)return {matter:request.result,review:this.reflectionReview(agent,reflectionId)};
    if(matter.version!==input.expectedVersion)fail('STALE_MATTER');const prior=this.reflectionReview(agent,reflectionId);if((input.expectedReviewVersion??0)!==(prior?.version??0))fail('STALE_REFLECTION_REVIEW');if(prior)fail('REFLECTION_ALREADY_REVIEWED');
    const action=input.action??'apply',suggestionAction=input.suggestionAction??reflection.suggestion?.action;if(action==='apply'&&!['pause','watch','drop','nextAction'].includes(suggestionAction))fail('INVALID_REFLECTION_SUGGESTION');
    if(action==='apply'&&this.projectReflection(agent,row).evidenceValidityChanged)fail('REFLECTION_EVIDENCE_CHANGED');
    if(terminal.has(matter.status)&&action==='apply')fail('MATTER_CLOSED');const reason=text(input.reason??(action==='apply'?'应用反思建议':'忽略反思建议'),500,true),data=this.checked(agent,{},matter),status=action==='dismiss'?matter.status:suggestionAction==='pause'?'paused':suggestionAction==='watch'?'watching':suggestionAction==='drop'?'dropped':matter.status;
    if(action==='apply'){data.nextAction=text(reflection.suggestion.nextAction,500,true);if(status==='watching'&&(!data.reason||!data.expectedOutcome||!data.stopCondition||!data.links.every(ref=>this.linkState(agent,ref).valid)))fail('MATTER_ATTENTION_CONTRACT_REQUIRED');}
    return this.journal.transaction(()=>{this.saveChange(matter,data,status,{actor:'owner',reason:'reflection-'+action+':'+reason,requestId:input.requestId,requestHash:request.hash});const now=this.checkpoint(agent);this.db.prepare('INSERT INTO human_reflection_review VALUES(?,?,?,1,?,?,?)').run(agent,reflectionId,matter.id,action==='apply'?'applied':'dismissed',JSON.stringify({action:suggestionAction,reason,actor:'owner',matterVersion:matter.version+1}),now);this.journal.audit(agent,'reflection-'+action,{reflectionId,matterId:matter.id,version:1,suggestionAction:action==='apply'?suggestionAction:null});return {matter:this.getMatter(agent,matter.id),review:this.reflectionReview(agent,reflectionId)};});
  }
  dismissReflectionSuggestion(agent,reflectionId,input={},options={}){return this.applyReflectionSuggestion(agent,reflectionId,{...input,action:'dismiss'},options);}
  bindTask(agent,task,{question='',value='',origin='agent'}={}){
    this.admitted(agent);if(!task||task.agent!==agent||!ident(task.id)||!this.linkState(agent,{type:'task',id:task.id}).exists)fail('TASK_NOT_FOUND');
    const checkpoint=plain(task.checkpoint)?task.checkpoint:parse(task.checkpoint)??{},linked=checkpoint.matterId;
    if(linked){
      const existing=this.raw(agent,linked);
      if(terminal.has(existing.status)||existing.status==='paused'||existing.status==='blocked')fail('MATTER_NOT_ATTENTION_READY');
      const otherLinks=existing.links.filter(ref=>ref.type!=='task'),taskSlots=Math.min(cognitionPolicy.taskLinkLimit,Math.max(0,24-otherLinks.length));
      const taskLinks=taskSlots?[...existing.links.filter(ref=>ref.type==='task'&&ref.id!==task.id),{type:'task',id:task.id}].slice(-taskSlots):[];
      const links=[...otherLinks,...(taskSlots?taskLinks:[])];
      // The exact checkpoint association remains authoritative when all link
      // slots are owner evidence. Never discard knowledge links to add history.
      if(hash(links)===hash(existing.links))return this.getMatter(agent,existing.id);
      const data=this.checked(agent,{links},existing),requestId='bind-task:'+task.id,requestHash=hash({matterId:existing.id,taskId:task.id});
      return this.journal.transaction(()=>{const old=this.db.prepare('SELECT request_hash FROM human_matter_request WHERE agent=? AND request_id=?').get(agent,requestId);if(old){if(old.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return this.getMatter(agent,existing.id);}this.saveChange(existing,data,existing.status,{actor:'system',reason:'task-linked',requestId,requestHash});return this.getMatter(agent,existing.id);});
    }
    const requestId='autonomy-task:'+task.id,prior=this.db.prepare('SELECT id FROM human_matter WHERE agent=? AND request_id=?').get(agent,requestId);if(prior)return this.getMatter(agent,prior.id);
    // Retain only the accepted task's question/value as an agent inference.
    // A task is not an owner promise or a new persistent personal preference.
    const title=String(question||checkpoint.plan?.question||checkpoint.candidate?.question||'自主任务').slice(0,160),why=String(value||checkpoint.plan?.value||'按现有自主任务记录继续推进。').slice(0,500),kind=['research','learn-ai'].includes(task.kind)?'research':['chat','care','share'].includes(task.kind)?'conversation':'other',refs=[{type:'task',id:task.id}];if(checkpoint.goal?.id&&this.linkState(agent,{type:'goal',id:checkpoint.goal.id}).exists)refs.push({type:'goal',id:checkpoint.goal.id});
    const created=this.createMatter(agent,{requestId,title,kind,why,expectedOutcome:'按已接受任务计划形成可核对结果；是否有价值仍需结果与反馈。',stopCondition:'主人介入、权限或预算不足、任务失败/取消，或本次任务结束时停止；失败不会自动重试。',nextAction:title,priority:50,refs},{actor:'agent'});
    return this.transitionMatter(agent,created.id,'watch',{requestId:'watch-task:'+task.id,expectedVersion:created.version,reason:'已存在的自主任务进入观察'},{actor:'agent'});
  }
  reconcile(agent,{since=0,limit=16}={}){
    this.admitted(agent);integer(since,0,Number.MAX_SAFE_INTEGER);integer(limit,1,64);if(this.journal.value(agent,'cognitionPreferredMatter',null)!==null&&!this.preferredMatter(agent)){this.journal.put(agent,'cognitionPreferredMatter',null);this.journal.audit(agent,'attention-preference-cleared',{reason:'preferred-matter-unavailable',executionRequested:false});}if(!this.table('autonomy_task'))return {reflected:0};const before=this.db.prepare('SELECT count(*) n FROM human_reflection WHERE agent=?').get(agent).n,unseen=this.db.prepare("SELECT id FROM autonomy_task WHERE agent=? AND status IN ('completed','failed','cancelled') AND updated>=? AND NOT EXISTS(SELECT 1 FROM human_reflection r WHERE r.agent=autonomy_task.agent AND r.task=autonomy_task.id) ORDER BY updated,id LIMIT ?").all(agent,since,Math.max(1,Math.ceil(limit/2))),recent=this.db.prepare("SELECT id FROM autonomy_task WHERE agent=? AND status IN ('completed','failed','cancelled') AND updated>=? ORDER BY updated DESC,id DESC LIMIT ?").all(agent,since,Math.floor(limit/2));for(const id of new Set([...unseen,...recent].map(row=>row.id)))this.reflectTask(agent,id);
    const focus=this.attentionState(agent);if(focus.taskId){const task=this.db.prepare('SELECT status FROM autonomy_task WHERE agent=? AND id=?').get(agent,focus.taskId);if(!task||taskTerminal.has(task.status))this.clearFocus(agent,'task-no-longer-active');}else if(focus.matterId&&focus.leaseUntil!==null&&focus.leaseUntil<=this.now(agent))this.clearFocus(agent,'focus-lease-expired');
    return {reflected:this.db.prepare('SELECT count(*) n FROM human_reflection WHERE agent=?').get(agent).n-before};
  }
  selfModel(agent,{runtime={}}={}){
    this.admitted(agent);const factory=this.factory,now=this.now(agent),profile=currentPersonaProfile(this.journal,agent,this.journal.value(agent,'personaState',null)?.core??DEFAULT_PERSONA_CORE),control=this.journal.get(agent),activeTasks=this.table('autonomy_task')?this.db.prepare("SELECT id,kind,status,created,updated FROM autonomy_task WHERE agent=? AND status IN ('ready','suspended','waiting-budget','executing') ORDER BY created,id LIMIT 8").all(agent):[],goals=this.table('goal_record')?this.db.prepare("SELECT id,description,status,expires,version FROM goal_record WHERE agent=? AND status IN ('proposed','active','paused','blocked','needs-evidence','awaiting-review') ORDER BY expires,id LIMIT 8").all(agent):[],capabilities=factory?.tools?.catalog(agent)??[];
    const status={desired:control.desired,phase:this.journal.value(agent,'autonomyPhase','unknown'),paused:this.journal.value(agent,'autonomyPaused',false),error:this.journal.value(agent,'autonomyError',null),waitReason:this.journal.value(agent,'autonomyWait',null),running:typeof runtime.running==='boolean'?runtime.running:null,activeLane:typeof runtime.activeLane==='string'?runtime.activeLane:null,origin:'runtime-fact'},uncertainties=['主人当前情绪与现实处境','任务对主人的真实价值和满意度','尚无有效来源支持的结论'];
    const commitments=this.db.prepare("SELECT id FROM human_matter WHERE agent=? AND status NOT IN ('completed','dropped') AND json_extract(data,'$.kind')='commitment' ORDER BY updated DESC,id LIMIT 12").all(agent).map(row=>{const matter=this.getMatter(agent,row.id);return {id:matter.id,title:matter.title,status:matter.status,source:matter.source,expectedOutcome:matter.expectedOutcome,origin:matter.origin,meaning:matter.origin==='owner'?'explicit-owner-board-entry':'agent-proposed-intention-not-owner-confirmed'};});
    return {version:1,at:now,sessionId:agent,basis:'live-config-and-persisted-execution-records',identity:profile?{name:profile.name??'',role:profile.role??'',configuredInterests:profile.interests??'',configuredGoals:profile.goals??'',sourceKind:'owner-config',origin:'owner-config'}:null,status,operation:status,capabilities:capabilities.slice(0,40).map(item=>({id:item.id,title:item.title,description:String(item.description??'').slice(0,240),effect:item.effect,available:item.available===true,autonomous:item.autonomous===true,unavailableReason:item.unavailableReason??null,scope:item.scope,authority:'Existing capability policy and exact write approval apply.',origin:'runtime-fact'})),activeTasks,goals,commitments,attention:this.attentionState(agent),uncertainties,unknowns:uncertainties,limits:{singleMainSession:true,singleExecutionLane:true,temporaryTaskContexts:true,subjectiveConsciousness:'not-established',selfDescriptionIsNotNewAuthority:true,thoughts:'Only observable intentions, decisions and concise outcome reviews; no private model chain of thought.'}};
  }
  snapshot(agent,options={}){
    this.admitted(agent);const counts=Object.fromEntries(cognitionPolicy.statuses.map(status=>[status,0]));for(const row of this.db.prepare('SELECT status,count(*) n FROM human_matter WHERE agent=? GROUP BY status').all(agent))if(Object.hasOwn(counts,row.status))counts[row.status]=row.n;
    const matters=this.listMatters(agent,{limit:50}),reflections=this.reflections(agent,{limit:12}),decisions=this.decisions(agent,{limit:20}),updatedAt=Math.max(0,this.db.prepare('SELECT max(updated) at FROM human_matter WHERE agent=?').get(agent)?.at??0,this.db.prepare('SELECT max(created) at FROM human_reflection WHERE agent=?').get(agent)?.at??0,this.db.prepare('SELECT max(updated) at FROM human_reflection_review WHERE agent=?').get(agent)?.at??0,this.db.prepare('SELECT max(created) at FROM human_cognition_decision WHERE agent=?').get(agent)?.at??0,this.attentionState(agent).selectedAt??0);
    return {version:1,updatedAt:updatedAt||null,sessionId:agent,revision:this.revision(agent),policy:cognitionPolicy,self:this.selfModel(agent,options),counts,items:matters.items,matters,attention:this.attentionCandidates(agent,options),decisions:decisions.items,decisionPage:decisions,reflections:reflections.items,reflectionPage:reflections,sharedBy:['owner','agent'],scope:'Shared intentions and evidence-backed software activity; no new model calls, execution authority, identity or IM channel.'};
  }
  export(agent){this.admitted(agent);return {version:1,self:this.selfModel(agent),matters:this.db.prepare('SELECT id FROM human_matter WHERE agent=? ORDER BY created,id').all(agent).map(row=>this.getMatter(agent,row.id)),revisions:this.db.prepare('SELECT matter,version,data,actor,reason,changed FROM human_matter_revision WHERE agent=? ORDER BY changed,matter,version').all(agent).map(row=>({...row,data:parse(row.data)})),attention:this.attentionState(agent),decisions:this.db.prepare('SELECT id,data,created FROM human_cognition_decision WHERE agent=? ORDER BY created,id').all(agent).map(row=>({...row,data:parse(row.data)})),reflections:this.db.prepare('SELECT id,data,created FROM human_reflection WHERE agent=? ORDER BY created,id').all(agent).map(row=>({...row,data:parse(row.data),review:this.reflectionReview(agent,row.id)}))};}
}
