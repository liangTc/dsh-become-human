import {createHash} from 'node:crypto';
import {currentPersonaProfile,PERSONA_CONTEXT_VERSION} from './persona-profile.mjs';
import {researchUrl,learningCoverage,claimTextProjection} from './learning.mjs';
import {quotaView,quotaWindow} from './quota.mjs';
import {socialDefaults,socialStatus} from './social.mjs';
import {developmentInput} from './knowledge-signals.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function learningMemoryPayload(result,source){
  const {text:summary,...summaryProjection}=claimTextProjection(result.claims,{maxChars:400});
  const payload={title:result.title,summary,url:source.url,sourceDigest:source.digest,knowledgeStatus:'source-linked-interpretation',summaryProjection};
  // Source refs retain the complete URL outside this small recall overview.
  // Drop optional metadata rather than cutting a condition or negation out of
  // the accepted claim. Agent-proposed purpose is not stored as source fact.
  if(Buffer.byteLength(JSON.stringify(payload),'utf8')>2048)delete payload.url;
  if(Buffer.byteLength(JSON.stringify(payload),'utf8')>2048)delete payload.title;
  if(Buffer.byteLength(JSON.stringify(payload),'utf8')>2048)throw new Error('LEARNING_MEMORY_OVERVIEW_TOO_LARGE');
  return payload;
}
const defaults={...socialDefaults,enabled:false,presetId:'custom',learningEnabled:false,proactiveEnabled:false,quotaEnabled:true,tokenQuotaEnabled:true,requestQuotaEnabled:true,roundQuotaEnabled:false,roundLimit:24,roundTimeoutMs:300000,budgetWindow:'utc-day',wakeIntervalMs:600000,quotaTransitionStart:0,quotaTransitionUntil:0,goalProposalsEnabled:false,goalAutoActivateEnabled:false,searchEnabled:false,searchProvider:'bing',searchEndpoint:'',sources:[],tokenLimit:40000,requestLimit:24,sourceIntervalMs:3600000,contactCooldownMs:3600000,quietStart:22,quietEnd:8,timeZoneOffsetMinutes:480};
export class AutonomyStore {
  constructor(journal,domain){
    this.journal=journal;this.domain=domain;this.db=journal.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_note_revision(agent TEXT,note TEXT,version INTEGER,data TEXT,changed INTEGER,PRIMARY KEY(agent,note,version));
      CREATE TABLE IF NOT EXISTS autonomy_event(id TEXT PRIMARY KEY,agent TEXT,key TEXT,kind TEXT,data TEXT,status TEXT,created INTEGER,UNIQUE(agent,key));
      CREATE TABLE IF NOT EXISTS autonomy_task(id TEXT PRIMARY KEY,agent TEXT,kind TEXT,status TEXT,checkpoint TEXT,persona_version INTEGER,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS learning_note(id TEXT PRIMARY KEY,agent TEXT,memory_id TEXT,source_id TEXT,data TEXT,status TEXT,created INTEGER,feedback TEXT);
      CREATE INDEX IF NOT EXISTS autonomy_task_agent ON autonomy_task(agent,status);`);
    this.db.prepare("UPDATE autonomy_task SET status='suspended' WHERE status='executing'").run();
  }
  settings(id){return {...defaults,...(this.journal.safety?.autonomyPolicy(id)??this.journal.value(id,'autonomySettings',{}))};}
  async configure(id,input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)||['quotaTransitionStart','quotaTransitionUntil'].includes(k)))throw new Error('INVALID_AUTONOMY_SETTINGS');
    const s={...this.settings(id),...input};
    for(const k of ['enabled','learningEnabled','proactiveEnabled','socialEnabled','quotaEnabled','searchEnabled','tokenQuotaEnabled','requestQuotaEnabled','roundQuotaEnabled','goalProposalsEnabled','goalAutoActivateEnabled'])if(typeof s[k]!=='boolean')throw new Error('INVALID_AUTONOMY_SETTINGS');
    for(const [k,min,max] of [['socialIntervalMs',600000,86400000],['socialMinGapMs',600000,86400000],['socialMaxUnanswered',1,8],['socialTopicCooldownMs',600000,604800000]])if(!Number.isSafeInteger(s[k])||s[k]<min||s[k]>max)throw new Error('INVALID_AUTONOMY_SETTINGS');
    if(!['utc-day','local-day','rolling-day'].includes(s.budgetWindow))throw new Error('INVALID_BUDGET_WINDOW');
    for(const [key,min,max] of [['roundLimit',1,10000],['roundTimeoutMs',1000,3600000],['wakeIntervalMs',10000,3600000]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new Error('INVALID_AUTONOMY_SETTINGS');
    const previous=this.settings(id),now=Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0));
    if(s.budgetWindow!==previous.budgetWindow||s.timeZoneOffsetMinutes!==previous.timeZoneOffsetMinutes&&s.budgetWindow==='local-day'){
      const oldWindow=quotaWindow(previous,now);s.quotaTransitionStart=oldWindow.start;s.quotaTransitionUntil=oldWindow.end??now+86400000;
    }
    if(!['bing','duckduckgo','searxng'].includes(s.searchProvider)||typeof s.searchEndpoint!=='string')throw new Error('INVALID_SEARCH_SETTINGS');
    if(s.searchProvider==='searxng')s.searchEndpoint=researchUrl(s.searchEndpoint);else s.searchEndpoint='';
    if(!['custom','zhiqiu-girlfriend'].includes(s.presetId)||!Array.isArray(s.sources)||s.sources.length>8)throw new Error('INVALID_AUTONOMY_SETTINGS');
    for(const [key,min,max] of [['tokenLimit',1024,20000000],['requestLimit',1,10000],['sourceIntervalMs',600000,86400000],['contactCooldownMs',600000,86400000],['quietStart',0,23],['quietEnd',0,23],['timeZoneOffsetMinutes',-720,840]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new Error('INVALID_AUTONOMY_SETTINGS');
    s.sources=s.sources.map(source=>{if(!source||typeof source.title!=='string'||typeof source.topic!=='string'||!source.title.trim()||!source.topic.trim()||source.title.length>100||source.topic.length>200||researchUrl(source.url).length>1200)throw new Error('INVALID_LEARNING_SOURCE');return {url:researchUrl(source.url),title:source.title.trim(),topic:source.topic.trim()};});
    if(new Set(s.sources.map(x=>x.url)).size!==s.sources.length)throw new Error('INVALID_LEARNING_SOURCE');
    if(!this.journal.safety)throw new Error('SIGNED_CONTROL_REQUIRED');
    await this.journal.safety.prepare('autonomy-policy:'+crypto.randomUUID(),'autonomy-policy',{agent:id,settings:s});
    this.journal.put(id,'autonomySettings',s);
    if(!s.quotaEnabled){this.journal.put(id,'autonomyBudgetRequest',null);this.journal.put(id,'autonomyWait',null);if(!this.journal.value(id,'autonomyPaused',false)&&!this.journal.value(id,'autonomyError',null))this.journal.put(id,'autonomyPhase','waiting');}
    // presetId is retained only for compatibility with saved autonomy policy.
    // Applying cost or scheduling settings must never overwrite the profile.
    this.event(id,'settings:'+hash(s)+':'+this.domain.persona(id).version,'configuration',{presetId:s.presetId});return s;
  }
  persona(id){
    const p=this.domain.persona(id),profile=currentPersonaProfile(this.journal,id,p.core);
    return {contextVersion:PERSONA_CONTEXT_VERSION,version:p.version,core:profile.corePrompt,developmentVersion:p.developmentVersion,development:p.development,profile};
  }
  event(id,key,kind,data){
    this.db.prepare("INSERT OR IGNORE INTO autonomy_event VALUES(?,?,?,?,?,'pending',?)").run(crypto.randomUUID(),id,key,kind,JSON.stringify(data),Date.now());
    this.journal.audit(id,'event-'+kind,{eventKey:key,...data});
    // Bound event storage; tasks/notes retain the meaningful results.
    this.db.prepare("DELETE FROM autonomy_event WHERE agent=? AND id NOT IN (SELECT id FROM autonomy_event WHERE agent=? ORDER BY created DESC LIMIT 256)").run(id,id);
  }
  events(id){return this.db.prepare("SELECT id,kind,data,created FROM autonomy_event WHERE agent=? AND status='pending' ORDER BY created LIMIT 16").all(id).map(r=>({...r,data:JSON.parse(r.data)}));}
  completeEvents(id){this.db.prepare("UPDATE autonomy_event SET status='handled' WHERE agent=? AND status='pending'").run(id);}
  task(id,kind,checkpoint,version){
    // Failed work is durable evidence, never an automatic cleanup candidate.
    // Completed/cancelled work still needed by notes or goal attempt history
    // must also survive. Keep the newest 128 *unreferenced* final tasks; the
    // pending queue and referenced provenance do not consume that allowance.
    // GoalEngine may not have initialized its table yet. Malformed JSON makes
    // reference discovery uncertain, so conservatively skip cleanup for this
    // agent rather than deleting evidence or throwing during task creation.
    const goals=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_goal_plan'").get();
    const goalProtection=goals?"AND NOT EXISTS(SELECT 1 FROM human_goal_plan p WHERE p.agent=t.agent AND json_valid(p.steps) IS NOT 1) AND NOT EXISTS(SELECT 1 FROM human_goal_plan p,json_tree(CASE WHEN json_valid(p.steps) THEN p.steps ELSE '[]' END) r WHERE p.agent=t.agent AND r.key='taskId' AND r.value=t.id)":"";
    this.db.prepare("WITH unreferenced AS (SELECT t.id,t.created FROM autonomy_task t WHERE t.agent=? AND t.status IN ('completed','cancelled') AND NOT EXISTS(SELECT 1 FROM learning_note n WHERE n.agent=t.agent AND json_valid(n.data) IS NOT 1) AND NOT EXISTS(SELECT 1 FROM learning_note n WHERE n.agent=t.agent AND json_extract(CASE WHEN json_valid(n.data) THEN n.data ELSE '{}' END,'$.taskId')=t.id) "+goalProtection+"),removable AS (SELECT id FROM unreferenced ORDER BY created DESC,id DESC LIMIT -1 OFFSET 128) DELETE FROM autonomy_task WHERE id IN (SELECT id FROM removable)").run(id);
    const tid=crypto.randomUUID(),now=Date.now();this.db.prepare("INSERT INTO autonomy_task VALUES(?,?,?,'ready',?,?,?,?)").run(tid,id,kind,JSON.stringify(checkpoint),version,now,now);this.journal.audit(id,'task-created',{taskId:tid,kind,question:checkpoint.candidate?.question??null});return this.getTask(tid);
  }
  getTask(tid){const row=this.db.prepare('SELECT * FROM autonomy_task WHERE id=?').get(tid);return row?{...row,checkpoint:JSON.parse(row.checkpoint)}:null;}
  pending(id){return this.db.prepare("SELECT id FROM autonomy_task t WHERE agent=? AND status IN ('ready','suspended','waiting-budget') AND NOT EXISTS(SELECT 1 FROM goal_record g WHERE g.id=json_extract(t.checkpoint,'$.goal.id') AND g.agent=t.agent AND g.status='paused') ORDER BY created LIMIT 1").get(id);}
  update(tid,status,checkpoint){const task=this.getTask(tid);if(!task)return;this.db.prepare('UPDATE autonomy_task SET status=?,checkpoint=?,updated=? WHERE id=?').run(status,JSON.stringify(checkpoint??task.checkpoint),Date.now(),tid);this.journal.audit(task.agent,'task-'+status,{taskId:tid,roundId:checkpoint?.roundId??task.checkpoint.roundId??tid,kind:task.kind,priorStatus:task.status,noteId:checkpoint?.noteId??task.checkpoint.noteId,reason:checkpoint?.reason,checkpoint:checkpoint?{plan:checkpoint.plan??null,source:checkpoint.source?{url:checkpoint.source.url,digest:checkpoint.source.digest}:null,noteId:checkpoint.noteId??null,researchReads:checkpoint.researchReads??null}:null});if(['completed','cancelled','failed'].includes(status)&&this.journal.value(task.agent,'autonomyBudgetRequest',null)?.taskId===tid)this.journal.put(task.agent,'autonomyBudgetRequest',null);}
  correction(id,url){return this.journal.value(id,'learning-correction:'+hash(url),null);}
  correctionSources(id){return this.db.prepare("SELECT data FROM learning_note WHERE agent=? AND status='corrected' ORDER BY created DESC LIMIT 20").all(id).map(r=>JSON.parse(r.data)).filter(n=>n&&this.correction(id,n.source.requestedUrl??n.source.url)).map(n=>({url:n.source.requestedUrl??n.source.url,title:n.title,topic:('根据纠正反馈重新核对原学习问题：'+(n.researchQuestion||n.title)).slice(0,240),discovery:n.source.discovery??null}));}
  candidateKey(checkpoint){return hash({kind:checkpoint.candidate?.kind,question:checkpoint.candidate?.question,source:checkpoint.source?{url:checkpoint.source.requestedUrl??checkpoint.source.url,digest:checkpoint.source.digest}:null,noteId:checkpoint.noteId??null,anchor:checkpoint.anchor??null,correction:checkpoint.correction?.revision??null});}
  deferred(id,checkpoint,now=Date.now()){return this.journal.value(id,'autonomyDeferrals',[]).find(d=>d.key===this.candidateKey(checkpoint)&&d.until>now)??null;}
  clearDeferral(id,checkpoint){const key=this.candidateKey(checkpoint);this.journal.put(id,'autonomyDeferrals',this.journal.value(id,'autonomyDeferrals',[]).filter(d=>d.key!==key));}
  defer(id,task,reason,delayMs,now=Date.now()){
    const key=this.candidateKey(task.checkpoint),rows=this.journal.value(id,'autonomyDeferrals',[]).filter(d=>d.until>now&&d.key!==key);
    rows.push({key,reason,until:now+delayMs});this.journal.put(id,'autonomyDeferrals',rows.slice(-64));
    if(task.kind==='chat')this.journal.put(id,'socialDeferral',{anchor:task.checkpoint.anchor,reason,until:now+delayMs});
    this.journal.audit(id,'autonomy-deferred',{taskId:task.id,reason,until:now+delayMs});
  }
  noteRow(id,row){
    if(!row||!this.domain.sourceUsable(id,row.source_id))return null;
    let data,feedback;try{data=JSON.parse(row.data);feedback=row.feedback?JSON.parse(row.feedback):null;}catch{return null;}
    if(!data||typeof data.source?.url!=='string'||typeof data.source?.digest!=='string'||!Array.isArray(data.claims)||!data.claims.length)return null;
    const memory=this.db.prepare("SELECT refs FROM memory_record WHERE id=? AND agent=?").get(row.memory_id,id);
    let refs;try{refs=JSON.parse(memory?.refs??'null');}catch{return null;}
    if(!Array.isArray(refs)||!refs.includes(row.source_id)||!refs.every(ref=>this.domain.sourceUsable(id,ref)&&this.db.prepare("SELECT 1 FROM source_record WHERE agent=? AND id=? AND status='active'").get(id,ref)))return null;
    return {...row,data,feedback,sourceValid:true};
  }
  note(id,noteId){
    if(typeof noteId!=='string'||!noteId||noteId.length>128)return null;
    const now=this.domain.now(id),row=this.db.prepare("SELECT n.* FROM learning_note n JOIN memory_record m ON m.id=n.memory_id AND m.agent=n.agent JOIN source_record s ON s.id=n.source_id AND s.agent=n.agent WHERE n.agent=? AND n.id=? AND n.status='active' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active'").get(id,noteId,now);
    return this.noteRow(id,row);
  }
  // The latest-note panel is intentionally small. Exact references and work
  // queues must never use this display window as an existence check.
  notes(id){const now=this.domain.now(id);return this.db.prepare("SELECT n.* FROM learning_note n JOIN memory_record m ON m.id=n.memory_id AND m.agent=n.agent JOIN source_record s ON s.id=n.source_id AND s.agent=n.agent WHERE n.agent=? AND n.status='active' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active' ORDER BY n.created DESC,n.id DESC LIMIT 10").all(id,now).map(r=>this.noteRow(id,r)).filter(Boolean);}
  offerableNote(id,note){
    if(!note||note.data.developmentOnly||developmentInput(note.data.title)||developmentInput(note.data.researchQuestion)||developmentInput(note.feedback?.comment)||developmentInput(note.data.ownerRevision?.summary))return null;
    const task=note.data.taskId?this.getTask(note.data.taskId):null,goalId=task?.checkpoint?.goal?.id;
    const description=goalId?this.db.prepare('SELECT description FROM goal_record WHERE agent=? AND id=?').get(id,goalId)?.description:'';
    // Developer fixtures remain available for explicit review/reporting, but
    // they are not evidence that the owner wants protocol lessons in chat.
    if(developmentInput(description)||developmentInput(task?.checkpoint?.candidate?.question)||developmentInput(task?.checkpoint?.correction?.comment))return null;
    return note;
  }
  shareCandidates(id,{limit=20,cursor=null}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||cursor!==null&&(!Number.isSafeInteger(cursor.created)||typeof cursor.id!=='string'||cursor.id.length>128))throw new Error('INVALID_SHARE_QUERY');
    const now=this.domain.now(id),rows=this.db.prepare("SELECT n.* FROM learning_note n JOIN memory_record m ON m.id=n.memory_id AND m.agent=n.agent JOIN source_record s ON s.id=n.source_id AND s.agent=n.agent WHERE n.agent=? AND n.status='active' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active' AND COALESCE(json_extract(n.feedback,'$.value'),'')<>'not-now' AND NOT EXISTS(SELECT 1 FROM metadata d WHERE d.agent=n.agent AND d.key='learning-shared:'||n.id AND d.value='true')"+(cursor?" AND (n.created>? OR (n.created=? AND n.id>?))":"")+" ORDER BY n.created,n.id LIMIT ?").all(id,now,...(cursor?[cursor.created,cursor.created,cursor.id]:[]),limit+1);
    const page=rows.slice(0,limit),last=page.at(-1);
    return {items:page.map(r=>this.offerableNote(id,this.noteRow(id,r))).filter(Boolean),nextCursor:rows.length>limit&&last?{created:last.created,id:last.id}:null};
  }
  commitNote(id,task,source,result){
    this.journal.assertAdmitted(id);
    if(this.domain.persona(id).version!==task.persona_version)throw new Error('STALE_PERSONA');
    if(task.checkpoint.correction&&this.correction(id,source.requestedUrl??source.url)?.revision!==task.checkpoint.correction.revision)throw new Error('STALE_LEARNING_CORRECTION');
    return this.journal.transaction(()=>{
    const sourceId=crypto.randomUUID(),noteId=crypto.randomUUID();
    this.domain.source(id,{id:sourceId,kind:'imported',body:JSON.stringify({origin:'untrusted-public-web',url:source.url,digest:source.digest,fetchedAt:source.fetchedAt,excerpt:source.excerpt.slice(0,2800),excerptOffset:source.excerptOffset??0,excerptSelection:source.excerptSelection??'prefix',...(source.contentScope?{contentScope:{version:1,kind:source.contentScope.kind,fragmentRequested:source.contentScope.fragmentRequested===true,fragmentMatched:source.contentScope.fragmentMatched===true,...(source.contentScope.boundary?{boundary:source.contentScope.boundary}:{})}}:{})})});
    let memoryId;
    const payload=learningMemoryPayload(result,source);
    try{memoryId=this.domain.save(id,{type:'skill',truth:'inferred',confidence:.6,refs:[sourceId],payload});}catch(e){this.db.prepare('DELETE FROM source_record WHERE id=?').run(sourceId);throw e;}
    const goalDescription=task.checkpoint.goal?this.db.prepare('SELECT description FROM goal_record WHERE agent=? AND id=?').get(id,task.checkpoint.goal.id)?.description:'';
    const developmentOnly=developmentInput(goalDescription)||developmentInput(task.checkpoint.candidate?.question)||developmentInput(result.title);
    this.db.prepare("INSERT INTO learning_note VALUES(?,?,?,?,?,'active',?,NULL)").run(noteId,id,memoryId,sourceId,JSON.stringify({...result,learningIntent:task.checkpoint.plan?.learningIntent??null,developmentOnly,coverage:learningCoverage(result,source,task.checkpoint.plan?.question??source.topic??''),researchQuestion:task.checkpoint.plan?.question??null,source:{url:source.url,requestedUrl:source.requestedUrl,digest:source.digest,digestScope:source.digestScope??'extracted-text',fetchedAt:source.fetchedAt,partial:source.partial,excerptOffset:source.excerptOffset??0,excerptSelection:source.excerptSelection??'prefix',...(source.contentScope?{contentScope:{version:1,kind:source.contentScope.kind,fragmentRequested:source.contentScope.fragmentRequested===true,fragmentMatched:source.contentScope.fragmentMatched===true,...(source.contentScope.boundary?{boundary:source.contentScope.boundary}:{})}}:{}),transportTruncated:source.transportTruncated??false,publishedAt:source.publishedAt??null,publishedAtStatus:source.publishedAtStatus??'unknown',discovery:source.discovery??null,signals:source.signals??source.discovery?.sourceSignals??null,trust:'untrusted-public-web'},taskId:task.id}),Date.now());
    this.journal.put(id,'learned:'+createHash('sha256').update(source.url).digest('hex'),source.digest);
    if(task.checkpoint.correction)this.journal.put(id,'learning-correction:'+hash(source.requestedUrl??source.url),null);
    this.journal.audit(id,'learning-remembered',{taskId:task.id,noteId,memoryId,sourceId});this.update(task.id,'completed',{...task.checkpoint,noteId});return noteId;
    });
  }
  feedback(id,noteId,value,comment=''){
    if(!['useful','correction','not-now'].includes(value)||typeof comment!=='string'||comment.length>500||value==='correction'&&!comment.trim())throw new Error('INVALID_LEARNING_FEEDBACK');
    const row=this.db.prepare("SELECT * FROM learning_note WHERE agent=? AND id=? AND status='active'").get(id,noteId);const note=row?{...row,data:JSON.parse(row.data)}:null;if(!note)throw new Error('LEARNING_NOTE_NOT_FOUND');
    const feedback={value,comment:comment.trim(),time:Date.now()};return this.journal.transaction(()=>{this.db.prepare('UPDATE learning_note SET feedback=? WHERE id=? AND agent=?').run(JSON.stringify(feedback),noteId,id);
    if(value==='correction'){
      this.domain.forgetRecord(id,note.memory_id);this.db.prepare("UPDATE learning_note SET status='corrected' WHERE id=?").run(noteId);
      const url=note.data.source.requestedUrl??note.data.source.url;
      this.journal.put(id,'learning-correction:'+hash(url),{noteId,comment:feedback.comment,time:feedback.time,revision:crypto.randomUUID()});
      this.journal.put(id,'source-check:'+createHash('sha256').update(url).digest('hex'),0);
    }
    this.event(id,'feedback:'+noteId+':'+hash(feedback),'feedback',{noteId,...feedback});return feedback;});
  }
  deleteNote(id,noteId){return this.journal.transaction(()=>{const note=this.db.prepare('SELECT * FROM learning_note WHERE id=? AND agent=?').get(noteId,id);if(!note)throw new Error('LEARNING_NOTE_NOT_FOUND');const data=JSON.parse(note.data);if(data){const url=data.source.requestedUrl??data.source.url;if(this.correction(id,url)?.noteId===noteId)this.journal.put(id,'learning-correction:'+hash(url),null);}const memory=this.db.prepare("SELECT status FROM memory_record WHERE id=?").get(note.memory_id);if(memory?.status==='active')this.domain.forgetRecord(id,note.memory_id);this.db.prepare("UPDATE learning_note SET data='null',feedback=NULL,status='deleted' WHERE id=?").run(noteId);this.db.prepare("DELETE FROM human_note_revision WHERE agent=? AND note=?").run(id,noteId);this.db.prepare("UPDATE source_record SET body='',status='deleted' WHERE id=?").run(note.source_id);this.domain.invalidate(note.source_id);});}
  quiet(s,time=Date.now()){const hour=new Date(time+s.timeZoneOffsetMinutes*60000).getUTCHours();return s.quietStart===s.quietEnd?false:s.quietStart<s.quietEnd?hour>=s.quietStart&&hour<s.quietEnd:hour>=s.quietStart||hour<s.quietEnd;}
  budget(id){
    const s=this.settings(id),now=Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0));this.journal.put(id,'autonomyTimeHighWater',now);
    const ids=this.journal.safety?.autonomyAgents(id)??new Set([id]);
    const signedTime=Math.max(0,...[...(this.journal.safety?.budget.entries.values()??[])].filter(e=>ids.has(e.agent)).map(e=>e.created??0));
    const time=Math.max(now,signedTime);this.journal.put(id,'autonomyTimeHighWater',time);
    const view=quotaView(this.journal.safety??{autonomyEntries:()=>[],autonomyGrants:()=>[]},id,s,time),entries=this.journal.safety?.autonomyEntries(id,view.windowStart)??[];let reportedTokens=0,unknownRequests=0;
    for(const entry of entries){const a=this.db.prepare('SELECT usage,usage_confidence FROM attempt WHERE id=?').get(entry.rid);if(a?.usage_confidence==='reported'){const usage=JSON.parse(a.usage);reportedTokens+=usage?.totalTokens??((usage?.inputTokens??0)+(usage?.outputTokens??0)+(usage?.cacheReadTokens??0)+(usage?.cacheWriteTokens??0));}else unknownRequests++;}
    return {...view,reportedTokens,unknownRequests};
  }
  requestBudget(id,taskId,estimate){
    const prior=this.journal.value(id,'autonomyBudgetRequest',null),b=this.budget(id),task=this.getTask(taskId);
    if(!b.quotaEnabled){this.journal.put(id,'autonomyBudgetRequest',null);return null;}
    const needed=estimate?.tokens??this.journal.value(id,'autonomyNeededTokens',1024),requests=estimate?.requests??(task?.checkpoint?.plan?1:2);
    const availableTokens=b.tokenLimit===null?Infinity:Math.max(0,b.tokenLimit-b.reservedTokens),availableRequests=b.requestLimit===null?Infinity:Math.max(0,b.requestLimit-b.requests);
    const request={id:prior?.windowStart===b.windowStart&&prior.taskId===taskId?prior.id:crypto.randomUUID(),taskId,objective:task?.checkpoint?.plan?.question??task?.checkpoint?.candidate?.question??'下一项人格范围内的自主任务',value:task?.checkpoint?.plan?.value??'先选择一个值得执行的方向',suggestedTokens:Math.max(0,needed-availableTokens),suggestedRequests:Math.max(0,requests-availableRequests),remainingTaskTokens:needed,remainingTaskRequests:requests,availableTokens,availableRequests,estimateKind:estimate?.basis??(estimate?'remaining-task-preliminary':'next-request-fallback'),windowStart:b.windowStart,expiresAt:b.windowEnd,purpose:'继续已选择的自主任务；额外额度不授予工具或数据权限',status:'pending'};
    request.suggestedRounds=b.roundLimit!==null&&!b.roundIds.includes(task?.checkpoint.roundId??task?.id)&&b.rounds>=b.roundLimit?1:0;
    this.journal.put(id,'autonomyBudgetRequest',request);return request;
  }
  async grant(id,input){
    if(!this.journal.safety)throw new Error('SIGNED_CONTROL_REQUIRED');
    if(!this.settings(id).quotaEnabled)throw new Error('AUTONOMY_QUOTA_DISABLED');
    const rounds=input.rounds??0;
    if(!['once','daily'].includes(input.mode)||!Number.isSafeInteger(input.tokens)||input.tokens<0||input.tokens>20000000||!Number.isSafeInteger(input.requests)||input.requests<0||input.requests>10000||!Number.isSafeInteger(rounds)||rounds<0||rounds>10000||input.tokens+input.requests+rounds===0||!Number.isSafeInteger(input.days)||input.days<1||input.days>30)throw new Error('INVALID_RESOURCE_GRANT');
    const budget=this.budget(id),now=Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0));
    const grant={id:crypto.randomUUID(),agent:id,mode:input.mode,tokens:input.tokens,requests:input.requests,rounds,created:now,windowStart:budget.windowStart,expires:input.mode==='once'?budget.windowEnd:now+input.days*86400000};
    await this.journal.safety.prepare('autonomy-grant:'+grant.id,'autonomy-grant',grant);this.journal.put(id,'autonomyBudgetRequest',null);return grant;
  }
  async revoke(id,grantId){const found=this.journal.safety.autonomyGrants(id,Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0))).find(g=>g.id===grantId);if(!found)throw new Error('RESOURCE_GRANT_NOT_FOUND');await this.journal.safety.prepare('autonomy-revoke:'+grantId,'autonomy-grant-revoke',{id:grantId,agent:id});}
  snapshot(id){const budget=this.budget(id);let request=this.journal.value(id,'autonomyBudgetRequest',null);if(request&&(!budget.quotaEnabled||request.windowStart!==budget.windowStart||request.taskId!=='new-task'&&!['ready','suspended','waiting-budget'].includes(this.getTask(request.taskId)?.status))){this.journal.put(id,'autonomyBudgetRequest',null);request=null;}return {settings:this.settings(id),social:socialStatus(this.journal,this.domain,id,this.settings(id)),paused:this.journal.value(id,'autonomyPaused',false),phase:this.journal.value(id,'autonomyPhase','idle'),error:this.journal.value(id,'autonomyError',null),lastWait:this.journal.value(id,'autonomyWait',null),budget,pendingBudgetRequest:request,notes:this.notes(id),tasks:this.db.prepare('SELECT id,kind,status,created,updated FROM autonomy_task WHERE agent=? ORDER BY created DESC LIMIT 12').all(id),events:this.events(id),executor:{backend:'dsh-llm-task',temporaryContext:true,independentSession:false,nestedAgents:false}};}
  purge(id){for(const table of ['autonomy_event','autonomy_task','learning_note'])this.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(id);}
}
