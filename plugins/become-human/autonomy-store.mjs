import {createHash} from 'node:crypto';
import {currentPersonaProfile,PERSONA_CONTEXT_VERSION} from './persona-profile.mjs';
import {researchUrl,learningCoverage,claimTextProjection} from './learning.mjs';
import {quotaView,quotaWindow,signedBudgetTime} from './quota.mjs';
import {socialDefaults,socialStatus} from './social.mjs';
import {defaultQuietHours,quietUntil,zoneOffsetMinutes} from './quiet-hours.mjs';
import {developmentInput} from './knowledge-signals.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function budgetShortfall(budget,tokens,requests,roundId){
  const availableTokens=budget.tokenLimit===null?null:Math.max(0,budget.tokenLimit-budget.reservedTokens);
  const availableRequests=budget.requestLimit===null?null:Math.max(0,budget.requestLimit-budget.requests);
  return {availableTokens,availableRequests,suggestedTokens:Math.max(0,tokens-(availableTokens??Infinity)),
    suggestedRequests:Math.max(0,requests-(availableRequests??Infinity)),
    suggestedRounds:budget.roundLimit!==null&&!budget.roundIds.includes(roundId)&&budget.rounds>=budget.roundLimit?1:0};
}
function budgetNoticeText(request){
  const parts=[];
  if(request.suggestedTokens>0)parts.push('约 '+Math.ceil(request.suggestedTokens).toLocaleString('en-US')+' token 的可用额度');
  if(request.suggestedRequests>0)parts.push(request.suggestedRequests+' 次请求');
  if(request.suggestedRounds>0)parts.push(request.suggestedRounds+' 轮自主活动');
  return '【自主额度申请】自主活动正在等待额度，本次预计还需 '+parts.join('、')+'。请在 Human 的“自主与额度”中查看并决定是否补充；这是准入预估，不是实际扣费，与你聊天仍可用。';
}
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
const defaults={...socialDefaults,enabled:false,presetId:'custom',learningEnabled:false,proactiveEnabled:false,quotaEnabled:true,tokenQuotaEnabled:true,requestQuotaEnabled:true,roundQuotaEnabled:false,roundLimit:24,roundTimeoutMs:300000,budgetWindow:'utc-day',wakeIntervalMs:600000,quotaTransitionStart:0,quotaTransitionUntil:0,goalProposalsEnabled:false,goalAutoActivateEnabled:false,searchEnabled:false,searchProvider:'bing',searchEndpoint:'',sources:[],tokenLimit:40000,requestLimit:24,sourceIntervalMs:3600000,contactCooldownMs:3600000,...defaultQuietHours,quietTimeZone:null,timeZoneOffsetMinutes:480};
export class AutonomyStore {
  constructor(journal,domain){
    this.journal=journal;this.domain=domain;this.db=journal.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_note_revision(agent TEXT,note TEXT,version INTEGER,data TEXT,changed INTEGER,PRIMARY KEY(agent,note,version));
      CREATE TABLE IF NOT EXISTS autonomy_event(id TEXT PRIMARY KEY,agent TEXT,key TEXT,kind TEXT,data TEXT,status TEXT,created INTEGER,UNIQUE(agent,key));
      CREATE TABLE IF NOT EXISTS autonomy_task(id TEXT PRIMARY KEY,agent TEXT,kind TEXT,status TEXT,checkpoint TEXT,persona_version INTEGER,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS learning_note(id TEXT PRIMARY KEY,agent TEXT,memory_id TEXT,source_id TEXT,data TEXT,status TEXT,created INTEGER,feedback TEXT);
      CREATE TABLE IF NOT EXISTS human_activity_feedback(task TEXT PRIMARY KEY,agent TEXT NOT NULL,created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,code TEXT,next_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS autonomy_task_agent ON autonomy_task(agent,status);
      CREATE INDEX IF NOT EXISTS autonomy_task_pending_order ON autonomy_task(agent,created,id) WHERE status IN ('ready','suspended','waiting-budget');`);
    this.db.prepare("UPDATE autonomy_task SET status='suspended' WHERE status='executing'").run();
  }
  settings(id){
    const policy=this.journal.safety?.autonomyPolicy(id)??this.journal.value(id,'autonomySettings',{});
    const settings={...defaults,...policy},legacy=this.legacyQuietHours;
    // Legacy onboarding recorded the zone separately. Respect subsequent manual offset changes.
    if(!Object.hasOwn(policy,'quietTimeZone')&&legacy?.sessionId===id&&settings.timeZoneOffsetMinutes===legacy.offset)
      settings.quietTimeZone=legacy.zone;
    return settings;
  }
  async configure(id,input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(defaults,k)||['quotaTransitionStart','quotaTransitionUntil'].includes(k)))throw new Error('INVALID_AUTONOMY_SETTINGS');
    const previous=this.settings(id),s={...previous,...input};
    if(!Object.hasOwn(input,'quietTimeZone')&&Object.hasOwn(input,'timeZoneOffsetMinutes')&&input.timeZoneOffsetMinutes!==previous.timeZoneOffsetMinutes)s.quietTimeZone=null;
    if(s.quietTimeZone!==null)zoneOffsetMinutes(s.quietTimeZone,Date.now());
    for(const k of ['enabled','learningEnabled','proactiveEnabled','socialEnabled','quotaEnabled','searchEnabled','tokenQuotaEnabled','requestQuotaEnabled','roundQuotaEnabled','goalProposalsEnabled','goalAutoActivateEnabled'])if(typeof s[k]!=='boolean')throw new Error('INVALID_AUTONOMY_SETTINGS');
    for(const [k,min,max] of [['socialIntervalMs',600000,86400000],['socialMinGapMs',600000,86400000],['socialMaxUnanswered',1,8],['socialTopicCooldownMs',600000,604800000]])if(!Number.isSafeInteger(s[k])||s[k]<min||s[k]>max)throw new Error('INVALID_AUTONOMY_SETTINGS');
    if(!['utc-day','local-day','rolling-day'].includes(s.budgetWindow))throw new Error('INVALID_BUDGET_WINDOW');
    for(const [key,min,max] of [['roundLimit',1,10000],['roundTimeoutMs',1000,3600000],['wakeIntervalMs',10000,3600000]])if(!Number.isSafeInteger(s[key])||s[key]<min||s[key]>max)throw new Error('INVALID_AUTONOMY_SETTINGS');
    const now=Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0));
    const windowChanged=s.budgetWindow!==previous.budgetWindow||s.timeZoneOffsetMinutes!==previous.timeZoneOffsetMinutes&&s.budgetWindow==='local-day';
    if(windowChanged){
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
    if(!s.quotaEnabled||windowChanged)this.journal.put(id,'autonomyBudgetRequest',null);
    else if(['tokenLimit','requestLimit','roundLimit','tokenQuotaEnabled','requestQuotaEnabled','roundQuotaEnabled'].some(key=>s[key]!==previous[key])){
      this.journal.put(id,'autonomyBudgetRequest',this.pendingBudgetRequest(id,now));
    }
    if(!s.quotaEnabled){this.journal.put(id,'autonomyWait',null);if(!this.journal.value(id,'autonomyPaused',false)&&!this.journal.value(id,'autonomyError',null))this.journal.put(id,'autonomyPhase','waiting');}
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
    // Bound handled history only. Pending events remain until acknowledged.
    this.db.prepare("DELETE FROM autonomy_event WHERE agent=? AND status='handled' AND id NOT IN (SELECT id FROM autonomy_event WHERE agent=? ORDER BY created DESC LIMIT 256)").run(id,id);
  }
  events(id,{advance=false}={}){
    const internal=this.db.prepare("SELECT id,kind,data,created FROM autonomy_event WHERE agent=? AND status='pending' ORDER BY created,id LIMIT 16").all(id).map(r=>({...r,data:JSON.parse(r.data)}));
    const external=this.pluginEvents?.events(id,{advance,limit:Math.max(8,16-internal.length)})??[],result=[];
    // Neither a backlog of internal events nor a busy plugin can hide the other.
    for(let i=0;result.length<16&&(i<internal.length||i<external.length);i++){if(internal[i])result.push(internal[i]);if(result.length<16&&external[i])result.push(external[i]);}
    return result;
  }
  completeEvents(id,eventIds=[]){for(const eventId of eventIds)this.db.prepare("UPDATE autonomy_event SET status='handled' WHERE agent=? AND id=? AND status='pending'").run(id,eventId);this.pluginEvents?.complete(id,eventIds);}
  selectOpportunity(tid,next,checkpoint){const task=this.getTask(tid);if(!task||task.kind!=='behavior-choice'||!['ready','executing'].includes(task.status))throw Error('STALE_BEHAVIOR_SELECTION');this.db.prepare('UPDATE autonomy_task SET kind=?,checkpoint=?,updated=? WHERE id=?').run(next.kind,JSON.stringify(checkpoint),Date.now(),tid);this.journal.audit(task.agent,'behavior-selected',{taskId:tid,kind:next.kind,behaviorId:next.behaviorId??null,opportunityId:next.opportunityId});return this.getTask(tid);}
  task(id,kind,checkpoint,version){
    // Failed work is durable evidence, never an automatic cleanup candidate.
    // Completed/cancelled work still needed by notes or goal attempt history
    // must also survive. Keep the newest 128 *unreferenced* final tasks; the
    // pending queue and referenced provenance do not consume that allowance.
    // GoalEngine may not have initialized its table yet. Malformed JSON makes
    // reference discovery uncertain, so conservatively skip cleanup for this
    // agent rather than deleting evidence or throwing during task creation.
    const goals=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_goal_plan'").get();
    const experienceProtection=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_experience'").get()?" AND NOT EXISTS(SELECT 1 FROM human_experience e WHERE e.agent=t.agent AND e.task=t.id)":'';
    const goalProtection=goals?"AND NOT EXISTS(SELECT 1 FROM human_goal_plan p WHERE p.agent=t.agent AND json_valid(p.steps) IS NOT 1) AND NOT EXISTS(SELECT 1 FROM human_goal_plan p,json_tree(CASE WHEN json_valid(p.steps) THEN p.steps ELSE '[]' END) r WHERE p.agent=t.agent AND r.key='taskId' AND r.value=t.id)":"";
    this.db.prepare("WITH unreferenced AS (SELECT t.id,t.created FROM autonomy_task t WHERE t.agent=? AND t.status IN ('completed','cancelled') AND NOT EXISTS(SELECT 1 FROM learning_note n WHERE n.agent=t.agent AND json_valid(n.data) IS NOT 1) AND NOT EXISTS(SELECT 1 FROM learning_note n WHERE n.agent=t.agent AND json_extract(CASE WHEN json_valid(n.data) THEN n.data ELSE '{}' END,'$.taskId')=t.id) "+goalProtection+experienceProtection+" AND NOT EXISTS(SELECT 1 FROM human_activity_feedback f WHERE f.agent=t.agent AND f.task=t.id)"+"),removable AS (SELECT id FROM unreferenced ORDER BY created DESC,id DESC LIMIT -1 OFFSET 128) DELETE FROM autonomy_task WHERE id IN (SELECT id FROM removable)").run(id);
    const tid=crypto.randomUUID(),now=Date.now();this.db.prepare("INSERT INTO autonomy_task VALUES(?,?,?,'ready',?,?,?,?)").run(tid,id,kind,JSON.stringify(checkpoint),version,now,now);this.journal.audit(id,'task-created',{taskId:tid,kind,question:checkpoint.candidate?.question??null});return this.getTask(tid);
  }
  getTask(tid){const row=this.db.prepare('SELECT * FROM autonomy_task WHERE id=?').get(tid);return row?{...row,checkpoint:JSON.parse(row.checkpoint)}:null;}
  pendingTasks(id,{after,limit=-1}={}){
    const query="SELECT id,created FROM autonomy_task t WHERE agent=? AND status IN ('ready','suspended','waiting-budget') AND NOT EXISTS(SELECT 1 FROM goal_record g WHERE g.id=json_extract(t.checkpoint,'$.goal.id') AND g.agent=t.agent AND g.status='paused')";
    const order=' ORDER BY created,id LIMIT ?';
    if(!after)return this.db.prepare(query+order).all(id,limit);
    const rows=this.db.prepare(query+' AND (created,id)>(?,?)'+order).all(id,after.created,after.id,limit);
    if(limit<0||rows.length<limit)rows.push(...this.db.prepare(query+' AND (created,id)<=(?,?)'+order).all(id,after.created,after.id,limit<0?-1:limit-rows.length));
    return rows;
  }
  pending(id){return this.pendingTasks(id,{limit:1})[0];}
  update(tid,status,checkpoint){return this.journal.transaction(()=>{const task=this.getTask(tid);if(!task)return;this.db.prepare('UPDATE autonomy_task SET status=?,checkpoint=?,updated=? WHERE id=?').run(status,JSON.stringify(checkpoint??task.checkpoint),Date.now(),tid);this.journal.audit(task.agent,'task-'+status,{taskId:tid,roundId:checkpoint?.roundId??task.checkpoint.roundId??tid,kind:task.kind,priorStatus:task.status,noteId:checkpoint?.noteId??task.checkpoint.noteId,reason:checkpoint?.reason,checkpoint:checkpoint?{plan:checkpoint.plan??null,source:checkpoint.source?{url:checkpoint.source.url,digest:checkpoint.source.digest}:null,noteId:checkpoint.noteId??null,researchReads:checkpoint.researchReads??null}:null});if(['completed','cancelled','failed'].includes(status)&&this.journal.value(task.agent,'autonomyBudgetRequest',null)?.taskId===tid)this.journal.put(task.agent,'autonomyBudgetRequest',null);if(['completed','cancelled','failed'].includes(status)&&task.kind!=='behavior-choice')this.db.prepare('INSERT INTO human_activity_feedback(task,agent,created) VALUES(?,?,?) ON CONFLICT(task) DO NOTHING').run(tid,task.agent,Date.now());});}
  correction(id,url){return this.journal.value(id,'learning-correction:'+hash(url),null);}
  correctionSources(id){return this.db.prepare("SELECT data FROM learning_note WHERE agent=? AND status='corrected' ORDER BY created DESC LIMIT 20").all(id).map(r=>JSON.parse(r.data)).filter(n=>n&&this.correction(id,n.source.requestedUrl??n.source.url)).map(n=>({url:n.source.requestedUrl??n.source.url,title:n.title,topic:('根据纠正反馈重新核对原学习问题：'+(n.researchQuestion||n.title)).slice(0,240),discovery:n.source.discovery??null}));}
  candidateKey(checkpoint){return hash({kind:checkpoint.candidate?.kind,question:checkpoint.candidate?.question,source:checkpoint.source?{url:checkpoint.source.requestedUrl??checkpoint.source.url,digest:checkpoint.source.digest}:checkpoint.sourceSpec?{url:checkpoint.sourceSpec.url}:null,noteId:checkpoint.noteId??null,anchor:checkpoint.anchor??null,correction:checkpoint.correction?.revision??null,...(checkpoint.behaviorId?{behaviorId:checkpoint.behaviorId,behaviorFingerprint:checkpoint.behaviorFingerprint,behaviorInput:checkpoint.behaviorInput??null}: {})});}
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
  quiet(s,time=Date.now()){return quietUntil(s,time)!==null;}
  budget(id,{now=Date.now(),includeUsage=true}={}){
    const ledger=this.journal.safety,highWater=this.journal.value(id,'autonomyTimeHighWater',0);
    const time=Math.max(now,highWater,signedBudgetTime(ledger,id));
    if(includeUsage&&time>highWater)this.journal.put(id,'autonomyTimeHighWater',time);
    const view=quotaView(ledger??{autonomyEntries:()=>[],autonomyGrants:()=>[]},id,this.settings(id),time);
    if(!includeUsage)return view;
    const entries=ledger?.autonomyEntries(id,view.windowStart)??[],lookup=this.db.prepare('SELECT usage,usage_confidence FROM attempt WHERE id=?');
    let reportedTokens=0,unknownRequests=0;
    for(const entry of entries){const a=lookup.get(entry.rid);if(a?.usage_confidence==='reported'){const usage=JSON.parse(a.usage);reportedTokens+=usage?.totalTokens??((usage?.inputTokens??0)+(usage?.outputTokens??0)+(usage?.cacheReadTokens??0)+(usage?.cacheWriteTokens??0));}else unknownRequests++;}
    return {...view,reportedTokens,unknownRequests};
  }
  pendingBudgetRequest(id,now=Date.now(),budget){
    const request=this.journal.value(id,'autonomyBudgetRequest',null);
    if(!request||request.status!=='pending'||request.expiresAt<=Math.max(now,this.journal.value(id,'autonomyTimeHighWater',0))||!this.settings(id).quotaEnabled)return null;
    if(request.taskId!=='new-task'){
      const development=request.taskId.startsWith('development:');
      const task=development?this.journal.value(id,'developmentReview',null):this.db.prepare('SELECT id,status FROM autonomy_task WHERE agent=? AND id=?').get(id,request.taskId);
      if(task?.id!==request.taskId||!['ready','suspended','waiting-budget'].includes(task.status))return null;
    }
    // Earlier releases keyed notices by the original window start. Preserve
    // their receipt on upgrade even as a rolling accounting window moves.
    const noticeKey=request.noticeKey??'autonomy-budget-notice:'+request.windowStart;
    const noticeSeq=request.noticeSeq??this.db.prepare('SELECT seq FROM outbox WHERE agent=? AND event_key=?').get(id,noticeKey)?.seq;
    const view=budget??this.budget(id,{now,includeUsage:false});
    if(!view.quotaEnabled||request.expiresAt<=view.now)return null;
    const priced=this.priceBudgetRequest({...request,noticeKey,noticeSeq},view);
    return priced?{...priced,noticeText:budgetNoticeText(priced)}:null;
  }
  requestBudget(id,taskId,estimate){
    const b=this.budget(id),prior=this.pendingBudgetRequest(id,b.now,b),task=this.getTask(taskId);
    if(!b.quotaEnabled){this.journal.put(id,'autonomyBudgetRequest',null);return null;}
    // There is one owner-facing approval slot. An unrelated waiting task must
    // not replace a still-actionable request and issue another notice each tick.
    if(prior&&prior.taskId!==taskId)return prior;
    const needed=estimate?.tokens??this.journal.value(id,'autonomyNeededTokens',1024),requests=estimate?.requests??(task?.checkpoint?.plan?1:2);
    const same=prior?.taskId===taskId?prior:null,requestId=same?.id??crypto.randomUUID(),roundId=task?.checkpoint.roundId??taskId;
    const request={id:requestId,taskId,roundId,objective:task?.checkpoint?.plan?.question??task?.checkpoint?.candidate?.question??(taskId.startsWith('development:')?'整理已有记忆与经历':'下一项人格范围内的自主任务'),value:task?.checkpoint?.plan?.value??'先选择一个值得执行的方向',remainingTaskTokens:needed,remainingTaskRequests:requests,...budgetShortfall(b,needed,requests,roundId),estimateKind:estimate?.basis??(estimate?'remaining-task-preliminary':'next-request-fallback'),windowStart:same?.windowStart??b.windowStart,expiresAt:same?.expiresAt??b.windowEnd,noticeKey:same?.noticeKey??'autonomy-budget-request:'+requestId,purpose:'继续已选择的自主任务；额外额度不授予工具或数据权限',status:'pending'};
    return this.journal.transaction(()=>{
      if(request.suggestedTokens||request.suggestedRequests||request.suggestedRounds){
        const policy=b.budgetWindow??this.settings(id).budgetWindow,now=b.now??Date.now();
        const notified=this.journal.value(id,'autonomyBudgetNoticePeriod',null);
        const inPeriod=notified?.policy===policy&&notified.expiresAt>now&&(policy==='rolling-day'||notified.windowStart===b.windowStart);
        const legacyNotice=policy!=='rolling-day'&&this.db.prepare('SELECT seq FROM outbox WHERE agent=? AND event_key=?').get(id,'autonomy-budget-notice:'+b.windowStart);
        if(same?.noticeSeq)request.noticeSeq=same.noticeSeq;
        else if(!inPeriod&&!legacyNotice){
          request.noticeSeq=this.journal.publish(id,budgetNoticeText(request),'budget-request',request.noticeKey);
        }
        if(request.noticeSeq&&!inPeriod)this.journal.put(id,'autonomyBudgetNoticePeriod',{policy,windowStart:b.windowStart,expiresAt:same?.noticeSeq?request.expiresAt:b.windowEnd});
      }
      this.journal.put(id,'autonomyBudgetRequest',request);return request;
    });
  }
  async grant(id,input){
    if(!this.journal.safety)throw new Error('SIGNED_CONTROL_REQUIRED');
    if(!this.settings(id).quotaEnabled)throw new Error('AUTONOMY_QUOTA_DISABLED');
    const rounds=input.rounds??0;
    if(!['once','daily'].includes(input.mode)||!Number.isSafeInteger(input.tokens)||input.tokens<0||input.tokens>20000000||!Number.isSafeInteger(input.requests)||input.requests<0||input.requests>10000||!Number.isSafeInteger(rounds)||rounds<0||rounds>10000||input.tokens+input.requests+rounds===0||!Number.isSafeInteger(input.days)||input.days<1||input.days>30)throw new Error('INVALID_RESOURCE_GRANT');
    const budget=this.budget(id),now=Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0));
    const grant={id:crypto.randomUUID(),agent:id,mode:input.mode,tokens:input.tokens,requests:input.requests,rounds,created:now,windowStart:budget.windowStart,expires:input.mode==='once'?budget.windowEnd:now+input.days*86400000};
    await this.journal.safety.prepare('autonomy-grant:'+grant.id,'autonomy-grant',grant);
    this.journal.put(id,'autonomyBudgetRequest',this.pendingBudgetRequest(id));
    return grant;
  }
  async revoke(id,grantId){const found=this.journal.safety.autonomyGrants(id,Math.max(Date.now(),this.journal.value(id,'autonomyTimeHighWater',0))).find(g=>g.id===grantId);if(!found)throw new Error('RESOURCE_GRANT_NOT_FOUND');await this.journal.safety.prepare('autonomy-revoke:'+grantId,'autonomy-grant-revoke',{id:grantId,agent:id});}
  priceBudgetRequest(request,budget){
    if(!request)return null;
    const roundId=request.roundId??this.getTask(request.taskId)?.checkpoint.roundId??request.taskId;
    const amounts=budgetShortfall(budget,request.remainingTaskTokens,request.remainingTaskRequests,roundId);
    return amounts.suggestedTokens||amounts.suggestedRequests||amounts.suggestedRounds?{...request,...amounts}:null;
  }
  snapshot(id){
    const budget=this.budget(id),pending=this.pendingBudgetRequest(id,budget.now,budget);
    return {settings:this.settings(id),social:socialStatus(this.journal,this.domain,id,this.settings(id)),paused:this.journal.value(id,'autonomyPaused',false),phase:this.journal.value(id,'autonomyPhase','idle'),error:this.journal.value(id,'autonomyError',null),lastWait:this.journal.value(id,'autonomyWait',null),budget,pendingBudgetRequest:pending,notes:this.notes(id),tasks:this.db.prepare('SELECT id,kind,status,created,updated FROM autonomy_task WHERE agent=? ORDER BY created DESC LIMIT 12').all(id),events:this.events(id),executor:{backend:'dsh-llm-task',temporaryContext:true,independentSession:false,nestedAgents:false}};}
  purge(id){for(const table of ['autonomy_event','autonomy_task','learning_note'])this.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(id);}
}
