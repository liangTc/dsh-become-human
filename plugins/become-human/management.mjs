import {createHash} from 'node:crypto';
import {characterBoard} from './cognition-runtime.mjs';
import {taskBoard} from './task-board.mjs';
import {roleState} from './role-state.mjs';
import {developmentStatus,retryDevelopment} from './development-runtime.mjs';
import {usageSummary,validatePrices,readiness} from './product-support.mjs';
import {usageStatistics} from './usage-statistics.mjs';
import {brainTimeline} from './timeline.mjs';
import {contextSettings,situation} from './context.mjs';
import {conversationSettings,validateConversationSettings} from './owner-turns.mjs';
import {SkillStore} from './skill-store.mjs';
import {topicMemorySnapshot} from './social.mjs';
import {currentPersonaProfile} from './persona-profile.mjs';
import {executionSettings as normalizeExecutionSettings} from './model-policy.mjs';
const fail=code=>{throw new Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||value.trim())?value.trim():fail('INVALID_CONFIGURATION');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max?value:fail('INVALID_CONFIGURATION');
const scrub=value=>String(value??'').replace(/([?&](?:token|api_key|access_token)=)[^\s&]+/gi,'$1[REDACTED]').replace(/sk-[\w-]{16,}/g,'[REDACTED]').slice(0,1200);
const parse=s=>{try{return JSON.parse(s);}catch{return {};}};
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
export class HumanManagement {
  constructor(factory){this.factory=factory;this.journal=factory.journal;this.db=this.journal.db;this.skills=new SkillStore(this.journal);this.db.exec(`CREATE TABLE IF NOT EXISTS human_memory_revision(agent TEXT,memory TEXT,version INTEGER,data TEXT,changed INTEGER,PRIMARY KEY(agent,memory,version));CREATE TABLE IF NOT EXISTS human_note_revision(agent TEXT,note TEXT,version INTEGER,data TEXT,changed INTEGER,PRIMARY KEY(agent,note,version));CREATE TABLE IF NOT EXISTS human_goal_request(agent TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,goal TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(agent,request_id));`);}
  revision(id){return this.journal.value(id,'humanConfigRevision',1);}
  contextStatus(id){const agent=[...(this.factory.handles??[])].map(h=>h.agent).find(a=>a?.id===id);return {strategy:'layered-lexical-v1',settings:contextSettings(this.journal,id),summary:'evidence-linked-derived-summaries-with-originals-retained',tokenizer:false,rolling:agent?this.factory.conversationSummary?.snapshot(agent)??null:null,rollingPreview:agent?this.factory.conversationSummary?.context(agent,{lane:'foreground',maxBytes:6144})??null:null,current:agent?situation(agent,this.factory.autonomy.pending(id)?this.factory.autonomy.getTask(this.factory.autonomy.pending(id).id):null):null,last:Object.fromEntries(['selection','executor','foreground','scheduled','conversation-summary'].map(lane=>[lane,this.journal.value(id,'contextLast:'+lane,null)]))};}
  handles(op){return ['conversation-summary-retry','relationship-configure','goal-propose','goal-transition','goal-retry','goal-revise','goal-review','goal-propose-gap','usage-prices-save','persona-development-configure','persona-development-revert','memory-lifecycle-configure','memory-lifecycle-restore','memory-lifecycle-pin','memory-lifecycle-archive','memory-lifecycle-recover','development-review-retry','profile-save','profile-rollback','execution-save','data-save','memory-revise','memory-forget','note-revise','skill-save','skill-toggle','skill-rollback'].includes(op);}
  async mutate(id,input){
    this.journal.assertAdmitted(id);
    if(input.op==='conversation-summary-retry'){const agent=[...(this.factory.handles??[])].map(h=>h.agent).find(a=>a?.id===id);if(!agent||!this.factory.conversationSummary)fail('SUMMARY_RUNTIME_UNAVAILABLE');return this.factory.conversationSummary.allowRetry(agent);}
    if(input.op==='relationship-configure'){
      if(!object(input.settings))fail('INVALID_RELATIONSHIP_SETTINGS');
      if(input.expectedRevision!==undefined)this.check(id,input.expectedRevision);
      const before=this.factory.relationship.settings(id),result=this.factory.relationship.configure(id,{...input.settings,expectedVersion:input.expectedVersion});
      if(result.version!==before.version)this.bump(id,'relationship-settings-updated',{version:result.version,permissionsChanged:false});return result;
    }
    if(input.op==='goal-propose'){
      if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.requestId))fail('INVALID_GOAL_REQUEST_ID');
      const payload={description:input.description,expires:input.expires,milestones:input.milestones,priority:input.priority??3,expectedValue:input.expectedValue??'',acceptance:input.acceptance??{}};
      const requestHash=createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
      return this.journal.transaction(()=>{
        const prior=this.db.prepare('SELECT request_hash,goal FROM human_goal_request WHERE agent=? AND request_id=?').get(id,input.requestId);
        if(prior){if(prior.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return this.factory.goals.get(id,prior.goal);}
        const source=crypto.randomUUID();this.factory.domain.source(id,{id:source,kind:'configuration',body:JSON.stringify({goalDescription:input.description})});
        const goal=this.factory.goals.propose(id,{...payload,refs:[source]});
        this.db.prepare('INSERT INTO human_goal_request VALUES(?,?,?,?,?)').run(id,input.requestId,requestHash,goal.id,Date.now());
        return goal;
      });
    }
    if(input.op==='goal-transition')return this.factory.goals.transition(id,input.goalId,input.action,{expectedVersion:input.expectedVersion});
    if(input.op==='goal-retry')return this.factory.goals.retry(id,input.goalId,{expectedVersion:input.expectedVersion,overrideBackoff:input.overrideBackoff});
    if(input.op==='goal-revise')return this.factory.goals.revise(id,input.goalId,input);
    if(input.op==='goal-review')return this.factory.goals.review(id,input.goalId,input);
    if(input.op==='goal-propose-gap')return this.factory.goals.proposeFromGap(id,input,{enabled:true});
    if(input.op==='persona-development-configure'){if(!Number.isSafeInteger(input.expectedVersion))fail('STALE_PERSONA_DEVELOPMENT');return this.factory.personaDevelopment.configure(id,{enabled:input.settings?.enabled,expectedVersion:input.expectedVersion});}
    if(input.op==='persona-development-revert')return this.factory.personaDevelopment.revert(id,input.changeId,input.expectedVersion);
    if(input.op==='memory-lifecycle-configure')return this.factory.memoryLifecycle.configure(id,input.settings,input.expectedVersion);
    if(input.op==='memory-lifecycle-restore')return this.factory.memoryLifecycle.restoreBatch(id,input.batchId,{expectedVersion:input.expectedVersion});
    if(input.op.startsWith('memory-lifecycle-')){const method={'memory-lifecycle-pin':'pin','memory-lifecycle-archive':'archive','memory-lifecycle-recover':'recover'}[input.op];if(method)return this.factory.memoryLifecycle[method](id,input.memoryId,{expectedVersion:input.expectedVersion});}
    if(input.op==='development-review-retry')return retryDevelopment(this.factory,id,input.jobId);
    if(input.op==='usage-prices-save'){this.check(id,input.expectedRevision);const prices=validatePrices(input.prices);this.journal.transaction(()=>{this.journal.put(id,'usagePrices',prices);this.bump(id,'usage-prices-configured',{routes:prices.length});});return;}
    const actions={'profile-save':()=>this.profileSave(id,input),'profile-rollback':()=>{const old=this.journal.value(id,'humanProfileHistory',[]).find(p=>p.version===input.version);if(!old)fail('PROFILE_REVISION_NOT_FOUND');return this.profileSave(id,{profile:old.profile,expectedRevision:input.expectedRevision});},'execution-save':()=>this.executionSave(id,input),'data-save':()=>this.dataSave(id,input),'memory-revise':()=>this.memoryRevise(id,input),'memory-forget':()=>this.memoryForget(id,input),'note-revise':()=>this.noteRevision(id,input),'skill-save':()=>this.skills.save(id,input.skill),'skill-toggle':()=>this.skills.toggle(id,input.name,input.enabled,input.expectedVersion),'skill-rollback':()=>this.skills.rollback(id,input.name,input.version,input.expectedVersion)};
    if(!actions[input.op])fail('UNKNOWN_OPERATION');
    const result=await actions[input.op]();if(input.op.startsWith('skill-'))this.bump(id,'skills-configured',{name:input.name??input.skill?.name});return result;
  }
  read(id,input={}){
    this.journal.assertAdmitted(id);
    if(input.kind==='relationship')return this.factory.relationship.snapshot(id);
    if(input.kind==='goal-list')return this.factory.goals.listPage(id,input);
    if(input.kind==='task-board')return taskBoard(this.factory,id,input);
    switch(input.kind){case 'work-observation':{const result=this.factory.workObservation.read(id,input);return {...result,status:{...result.status,requested:this.journal.value(id,'workObservationRequested',false)}};}case 'usage-statistics':return usageStatistics(this.factory,id,input);case 'persona-development':return {...this.factory.personaDevelopment.snapshot(id),runtime:developmentStatus(this.factory,id)};case 'memory-lifecycle':return {...this.factory.memoryLifecycle.status(id),runtime:developmentStatus(this.factory,id)};case 'character-board':return characterBoard(this.factory,id,{limit:input.limit});case 'board-matter-history':return this.factory.cognition.history(id,input.id);case 'board-matters':return this.factory.cognition.listMatters(id,{status:input.status,origin:input.origin,query:input.query,limit:input.limit,offset:input.offset});case 'board-reflections':return this.factory.cognition.reflections(id,{limit:input.limit,offset:input.offset,taskId:input.taskId});case 'role-state':return roleState(this.journal,this.factory.domain,id);case 'readiness':return readiness(this.factory,id);case 'usage-summary':return usageSummary(this.journal,id,input);case 'capability-settings':return this.factory.tools.configuration(id);case 'capability-status':return {mcp:this.factory.mcpCapabilities.status(),customMcp:this.factory.customMcpCapabilities.status(),bridgeAvailable:process.connected===true};case 'tool-catalog':return this.factory.tools.catalog(id);case 'tool-jobs':return this.factory.tools.list(id,input);case 'tool-job':return this.factory.tools.get(id,input.jobId);case 'actions':return this.factory.actions.list(id);case 'action':return this.factory.actions.preview(id,input.actionId);case 'action-content':return this.factory.actions.readContent(id,input.actionId);case 'action-notes':return this.factory.actions.eligibleNotes(id);case 'goals':return this.factory.goals.list(id,{status:input.status||undefined,limit:input.limit??32});case 'goal':return this.factory.goals.get(id,input.goalId);case 'social-topics':return topicMemorySnapshot(this.journal,this.factory.domain,id);case 'context-status':return this.contextStatus(id);case 'schedule-history':return this.factory.reminders.history(id,input.id);case 'brain-timeline':return brainTimeline(this,id,input);case 'profile-history':return this.journal.value(id,'humanProfileHistory',[]);case 'activity':return this.activity(id,input);case 'task':return this.task(id,input.taskId);case 'memories':return this.memoryList(id,input);case 'memory-history':return this.memoryHistory(id,input.memoryId);case 'notes':return this.notes(id,input);case 'note-history':return this.db.prepare('SELECT version,data,changed FROM human_note_revision WHERE agent=? AND note=? ORDER BY version DESC LIMIT 100').all(id,input.noteId).map(r=>({...r,data:parse(r.data)}));case 'skill':return this.skills.get(id,input.name)??fail('SKILL_NOT_FOUND');case 'skill-history':return this.skills.history(id,input.name);case 'export':return this.export(id);default:fail('UNKNOWN_READ');}
  }
  check(id,expected){if(expected!==this.revision(id))fail('STALE_CONFIGURATION');}
  bump(id,kind,data={}){this.journal.put(id,'humanConfigRevision',this.revision(id)+1);this.journal.audit(id,kind,data);}
  profile(id){return currentPersonaProfile(this.journal,id,this.factory.domain.persona(id).core);}
  reconcileProfile(id){
    const current=this.factory.domain.persona(id),profile=this.profile(id);
    if(profile.corePrompt===current.core)return false;
    // Old autonomy preset application could overwrite only personaState.core.
    // Restore the explicitly saved profile before any agent is resumed.
    this.journal.transaction(()=>{this.factory.domain.setCore(id,profile.corePrompt);this.bump(id,'profile-core-reconciled',{reason:'saved-profile-is-authoritative',previousPersonaVersion:current.version,personaVersion:this.factory.domain.persona(id).version});});
    return true;
  }
  execution(id){return normalizeExecutionSettings({reasoningEffort:this.factory.config.reasoningEffort??'',routes:{},...this.journal.value(id,'humanExecution',{}),context:contextSettings(this.journal,id),conversation:conversationSettings(this.journal,id)});}
  modelCapabilities(){
    const allowed=this.factory.config.allowedRoutes?.length?this.factory.config.allowedRoutes:[{provider:this.factory.config.provider,model:this.factory.config.model}];
    return (this.factory.config.modelCapabilities??[]).filter(cap=>object(cap)&&typeof cap.provider==='string'&&typeof cap.model==='string'&&['pi-ai','deepseek-native'].includes(cap.adapter)&&allowed.some(route=>route.provider===cap.provider&&route.model===cap.model)).slice(0,512).map(cap=>({provider:cap.provider,model:cap.model,adapter:cap.adapter,...(Array.isArray(cap.inputModalities)?{inputModalities:[...new Set(cap.inputModalities.filter(value=>value==='text'||value==='image'))]}:{}),...(Array.isArray(cap.reasoningEfforts)?{reasoningEfforts:[...new Set(cap.reasoningEfforts.filter(value=>['off','low','medium','high','max'].includes(value)))]}:{})}));
  }
  reasoningEfforts(route){
    const cap=this.modelCapabilities().find(item=>item.provider===route.provider&&item.model===route.model);
    if(cap?.adapter!=='deepseek-native')return ['low','medium','high'];
    const native=['off','low','high','max'];
    return Array.isArray(cap.reasoningEfforts)?native.filter(value=>cap.reasoningEfforts.includes(value)):native;
  }
  assertReasoningEffort(effort,routes){
    if(typeof effort!=='string'||!['','off','low','medium','high','max'].includes(effort))fail('INVALID_REASONING_EFFORT');
    if(effort&&routes.some(route=>!this.reasoningEfforts(route).includes(effort)))fail('MODEL_REASONING_EFFORT_UNSUPPORTED');
    return effort;
  }
  options(id,lane){
    const e=this.execution(id),route={provider:this.factory.config.provider,model:this.factory.config.model,...e.routes[lane==='foreground'?'foreground':lane==='selection'?'selection':'executor']};
    const reasoningEffort=this.assertReasoningEffort(e.reasoningEffort,[route]);
    const {maxTokens,requestTimeoutMs,...config}=this.factory.config;
    return {...config,...route,reasoningEffort:reasoningEffort||undefined};
  }
  dataSettings(id){return {logRetentionDays:30,logRetentionEnabled:false,...this.journal.value(id,'humanDataSettings',{})};}
  maintain(id){if((this.lastPrune?.[id]??0)>Date.now()-3600000)return;this.lastPrune??={};this.lastPrune[id]=Date.now();const p=this.dataSettings(id);if(p.logRetentionEnabled){this.journal.events.prune(id,p.logRetentionDays);this.db.prepare("DELETE FROM audit WHERE agent=? AND CAST(json_extract(data,'$.time') AS INTEGER)<?").run(id,Date.now()-p.logRetentionDays*86400000);}}
  snapshot(id){this.maintain(id);return {revision:this.revision(id),profile:this.profile(id),execution:this.execution(id),allowedRoutes:this.factory.config.allowedRoutes??[],modelCapabilities:this.modelCapabilities(),skills:this.skills.list(id),data:this.dataSettings(id),toolRevision:this.db.prepare('SELECT COALESCE(sum(version),0) AS n FROM human_tool_job WHERE agent=?').get(id).n,capabilityRevision:this.factory.tools.configuration(id).revision,actionRevision:this.db.prepare('SELECT COALESCE(sum(version),0) AS n FROM human_action WHERE agent=?').get(id).n,actionLoopError:this.journal.value(id,'actionLoopError',null),capabilities:{personaDevelopment:true,memoryLifecycle:true,optionalWindowsServiceHost:true,encryptedOfflineBackup:true,publicToolJobs:true,capabilityContract:1,exactToolApproval:true,readOnlyMcp:true,hostSessionBridge:true,browserCdpAdapter:true,goalAcceptance:true,goalPriority:true,completeReadableExport:true,usageBreakdown:true,ownerInputBatching:true,naturalShortReplies:true,localReportActions:true,exactActionApproval:true,actionKinds:['write-report'],naturalLanguageSchedules:true,ownerGoalCommands:true,localCommandRecovery:true,socialConversation:true,longTermTopics:true,goalProgression:true,multiplePreferences:true,layeredMemory:true,contextInputBudgets:false,modelLimitPolicy:'host-provider-defaults',liveSituation:true,contextTokenizer:false,nativePanel:true,roundQuota:true,roundTimeout:true,quotaWindows:['utc-day','local-day','rolling-day'],memoryRevisions:true,skillSources:['manual','local','github'],skillExecution:'text-in-existing-model-call',scriptSkills:false,backgroundService:false,codexExecutor:false,toolPermissions:'registered-capabilities-with-exact-write-approval'}};}
  profileSave(id,input){
    this.check(id,input.expectedRevision);const p=input.profile;if(!object(p))fail('INVALID_CONFIGURATION');
    const next={};for(const [k,max,required] of [['name',64,true],['role',160,false],['interests',500,false],['goals',800,false],['ownerName',80,false],['ownerCity',100,false],['ownerPreferences',800,false],['corePrompt',512,true]])next[k]=text(p[k]??'',max,required);
    this.journal.transaction(()=>{const history=this.journal.value(id,'humanProfileHistory',[]);history.push({version:this.revision(id),time:Date.now(),profile:this.profile(id)});this.journal.put(id,'humanProfileHistory',history.slice(-50));this.factory.domain.setCore(id,next.corePrompt);this.journal.put(id,'humanProfile',next);this.bump(id,'profile-updated',{personaVersion:this.factory.domain.persona(id).version});});
  }
  executionSave(id,input){
    this.check(id,input.expectedRevision);const e=input.execution;if(!object(e)||!object(e.routes)||!object(e.context))fail('INVALID_CONFIGURATION');
    const allowed=this.factory.config.allowedRoutes?.length?this.factory.config.allowedRoutes:[{provider:this.factory.config.provider,model:this.factory.config.model}],routes={};
    for(const lane of ['foreground','selection','executor']){const r=e.routes[lane];if(!r||!allowed.some(a=>a.provider===r.provider&&a.model===r.model))fail('MODEL_ROUTE_NOT_ALLOWED');routes[lane]={provider:r.provider,model:r.model};}
    const next={reasoningEffort:this.assertReasoningEffort(e.reasoningEffort,Object.values(routes)),routes,context:{memoryLimit:integer(e.context.memoryLimit,1,100),historyLimit:integer(e.context.historyLimit,1,40),learningLimit:integer(e.context.learningLimit,0,10)},conversation:e.conversation===undefined?conversationSettings(this.journal,id):validateConversationSettings(e.conversation,conversationSettings(this.journal,id))};
    this.journal.transaction(()=>{this.journal.put(id,'humanExecution',next);this.bump(id,'execution-configured',{routes,modelLimitPolicy:'host-provider-defaults'});});
  }

  dataSave(id,input){this.check(id,input.expectedRevision);if(typeof input.enabled!=='boolean')fail('INVALID_CONFIGURATION');const s={logRetentionDays:integer(input.days,1,3650),logRetentionEnabled:input.enabled};this.journal.transaction(()=>{this.journal.put(id,'humanDataSettings',s);this.bump(id,'data-configured',s);if(s.logRetentionEnabled){this.db.prepare("DELETE FROM audit WHERE agent=? AND CAST(json_extract(data,'$.time') AS INTEGER)<?").run(id,Date.now()-s.logRetentionDays*86400000);this.journal.events.prune(id,s.logRetentionDays);}});}
  memoryList(id,input={}){const limit=integer(input.limit??20,1,100),offset=integer(input.offset??0,0,100000),type=input.type||'',query=text(input.query??'',128).toLowerCase();this.journal.assertAdmitted(id);const now=this.factory.domain.now(id);
    const records=this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND status<>'deleted' ORDER BY valid_from DESC").all(id).filter(r=>(!type||r.type===type)&&(!input.activeOnly||r.status==='active'&&(r.valid_to===null||r.valid_to>now))&&(!query||r.payload.toLowerCase().includes(query)||r.id.includes(query)));
    return {total:records.length,offset,limit,items:records.slice(offset,offset+limit).map(r=>({...r,payload:parse(r.payload),refs:parse(r.refs),roots:parse(r.roots),expired:r.valid_to!==null&&r.valid_to<=now,evidence:parse(r.refs).map(ref=>this.db.prepare('SELECT id,kind,occurred,body,hash,status FROM source_record WHERE agent=? AND id=?').get(id,ref)).filter(Boolean)}))};
  }
  memoryHistory(id,memory){const row=this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND id=? AND status<>'deleted'").get(id,memory);if(!row)fail('MEMORY_NOT_FOUND');return {current:row,versions:this.db.prepare('SELECT version,data,changed FROM human_memory_revision WHERE agent=? AND memory=? ORDER BY version DESC LIMIT 100').all(id,memory).map(r=>({...r,data:parse(r.data)}))};}
  memoryRevise(id,input){
    const old=this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND id=? AND status='active'").get(id,input.memoryId);if(!old)fail('MEMORY_NOT_FOUND');if(old.version!==input.expectedVersion)fail('STALE_MEMORY');if(old.type==='skill')fail('USE_LEARNING_NOTE_EDITOR');
    const payload=input.payload,encoded=JSON.stringify(payload);if(!object(payload)||encoded.length>2048||/(?:sk-[\w-]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/i.test(encoded))fail('INVALID_MEMORY');
    const now=Date.now(),validTo=input.validTo??null;if(validTo!==null&&(!Number.isSafeInteger(validTo)||validTo<=now))fail('INVALID_EXPIRY');
    this.journal.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO human_memory_revision VALUES(?,?,?,?,?)').run(id,old.id,old.version,JSON.stringify(old),now);
      for(const root of parse(old.roots))this.db.prepare('INSERT OR IGNORE INTO extraction_block VALUES(?,?,?)').run(id,root,'owner-revised:'+old.id);
      const source=crypto.randomUUID();this.factory.domain.source(id,{id:source,body:encoded,kind:'configuration',namespace:old.namespace});this.factory.domain.invalidate(old.id);
      this.db.prepare("DELETE FROM dependency WHERE dependent=? AND kind='memory'").run(old.id);
      this.db.prepare("UPDATE memory_record SET payload=?,truth=?,confidence=1,refs=?,roots=?,valid_from=?,valid_to=?,version=version+1 WHERE id=? AND agent=?").run(encoded,old.namespace==='fictional'?'fictional':'factual',JSON.stringify([source]),JSON.stringify([source]),now,validTo,old.id,id);
      this.db.prepare('INSERT INTO dependency VALUES(?,?,?)').run(source,old.id,'memory');const next=this.db.prepare('SELECT * FROM memory_record WHERE id=?').get(old.id);this.db.prepare('INSERT INTO human_memory_revision VALUES(?,?,?,?,?)').run(id,old.id,next.version,JSON.stringify({...next,actor:'owner-revision'}),now);this.journal.audit(id,'memory-revised',{memoryId:old.id,fromVersion:old.version,version:next.version});this.factory.goals?.reconcile(id);
    });
  }
  memoryForget(id,input){const r=this.db.prepare('SELECT version FROM memory_record WHERE id=? AND agent=?').get(input.memoryId,id);if(!r)fail('MEMORY_NOT_FOUND');if(r.version!==input.expectedVersion)fail('STALE_MEMORY');this.journal.transaction(()=>{this.factory.domain.forgetRecord(id,input.memoryId);this.db.prepare("UPDATE human_memory_revision SET data='null' WHERE agent=? AND memory=?").run(id,input.memoryId);this.journal.audit(id,'memory-forgotten',{memoryId:input.memoryId});this.factory.goals?.reconcile(id);});}
  notes(id,input={}){const offset=integer(input.offset??0,0,100000),limit=integer(input.limit??20,1,100);const rows=this.db.prepare("SELECT n.* FROM learning_note n JOIN memory_record m ON m.id=n.memory_id WHERE n.agent=? AND n.status<>'deleted' ORDER BY n.created DESC").all(id);return {total:rows.length,items:rows.slice(offset,offset+limit).map(r=>({...r,data:parse(r.data),feedback:parse(r.feedback)}))};}
  noteRevision(id,input){const note=this.db.prepare("SELECT * FROM learning_note WHERE agent=? AND id=? AND status='active'").get(id,input.noteId);if(!note)fail('LEARNING_NOTE_NOT_FOUND');const data=parse(note.data),version=data.ownerRevision?.version??0;if(version!==input.expectedVersion)fail('STALE_NOTE');const summary=text(input.summary,2000,true);this.journal.transaction(()=>{this.db.prepare('INSERT INTO human_note_revision VALUES(?,?,?,?,?)').run(id,note.id,version+1,JSON.stringify({summary,kind:'owner-annotation',version:version+1}),Date.now());data.ownerRevision={summary,kind:'owner-annotation',version:version+1,time:Date.now()};this.db.prepare('UPDATE learning_note SET data=? WHERE id=?').run(JSON.stringify(data),note.id);this.journal.audit(id,'note-revised',{noteId:note.id,version:version+1});});}
  activity(id,input={}){const s=this.dataSettings(id);if(s.logRetentionEnabled)this.journal.events.prune(id,s.logRetentionDays);return {...this.journal.events.query(id,input),tracingSince:this.journal.value(id,'nativeTracingSince',null)};}
  task(id,taskId){const t=this.factory.autonomy.getTask(taskId);if(t&&t.agent!==id)fail('TASK_NOT_FOUND');const trace=this.journal.events.task(id,taskId);if(!t&&!trace.length)fail('TASK_NOT_FOUND');return {...(t??{id:taskId,status:'archived'}),goalId:t?.checkpoint?.goal?.id??this.factory.goals.linked(id,taskId)?.goal??null,trace,attempts:this.db.prepare('SELECT id,state,usage,usage_confidence,error,started,ended,request FROM attempt WHERE agent=? AND json_extract(request,\'$.taskId\')=? ORDER BY started').all(id,taskId).map(({request,...r})=>({...r,roundId:parse(request).roundId??taskId,usage:parse(r.usage)}))};}
  allPages(id,method){const all=[];for(let offset=0;;offset+=100){const page=this[method](id,{limit:100,offset});all.push(...page.items);if(all.length>=page.total)return all;}}
  export(id){const result={format:'human-export-v3',conversationSummary:this.factory.conversationSummary?this.contextStatus(id).rollingPreview:null,conversationSummaryScope:'Validated active projection only; derived cache can be rebuilt from original session events. Operational backup retains cache metadata.',multimodal:this.factory.media?.export(id)??null,relationship:this.factory.relationship?.snapshot(id)??null,workObservation:this.factory.workObservation?.export(id)??null,personaDevelopment:this.factory.personaDevelopment.export(id),memoryLifecycle:this.factory.memoryLifecycle.export(id),developmentReview:developmentStatus(this.factory,id),cognition:this.factory.cognition.export(id),exportedAt:new Date().toISOString(),sessionId:id,profile:this.profile(id),execution:this.execution(id),autonomy:this.factory.autonomy.settings(id),skills:this.skills.list(id,{content:true}),memories:this.allPages(id,'memoryList'),notes:this.allPages(id,'notes'),goals:this.db.prepare('SELECT p.goal id FROM human_goal_plan p WHERE p.agent=? ORDER BY p.created,p.goal').all(id).map(r=>this.factory.goals.get(id,r.id)),actions:this.db.prepare('SELECT id FROM human_action WHERE agent=? ORDER BY created,id').all(id).map(r=>this.factory.actions.get(id,r.id)),toolJobs:this.db.prepare('SELECT id FROM human_tool_job WHERE agent=? ORDER BY created,id').all(id).map(r=>this.factory.tools.get(id,r.id)),completeness:{cognition:'all',goals:'all',actions:'all',notes:'all',memories:'all',messages:'all',toolJobs:'all'},capabilitySettings:this.factory.tools.configuration(id),usagePrices:this.journal.value(id,'usagePrices',[]),topicMemory:topicMemorySnapshot(this.journal,this.factory.domain,id),reminders:this.factory.reminders.list(id),messages:this.db.prepare('SELECT seq,kind,text,created FROM outbox WHERE agent=? ORDER BY seq').all(id),budget:this.factory.autonomy.budget(id),credentials:'references-only; no DPAPI key, credential values or control signing key exported',scope:'Complete readable records, not an operational backup. Credentials/signing keys are excluded. Use offline-store.mjs for same-Windows-user backup and restore.'};if(Buffer.byteLength(JSON.stringify(result))>8388608)fail('EXPORT_TOO_LARGE');return result;}
  close(){this.skills.close();}
}
