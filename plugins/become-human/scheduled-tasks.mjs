import {createAfterScheduleRecord,createAtScheduleRecord,createEveryScheduleRecord,createDailyScheduleRecord,createWeeklyScheduleRecord,createCronScheduleRecord,resolveRecurringOccurrence,isRecurringScheduleRecord,decodeScheduleRecord} from './vendor/schedule-rules.mjs';
const parse=s=>s?JSON.parse(s):null;
const clean=(value,max,multiline=false)=>typeof value==='string'&&value.trim()&&value.trim().length<=max&&!(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u:/[\u0000-\u001f]/u).test(value)&&!/(?:sk-[\w-]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value)?value.trim():(()=>{throw new Error('INVALID_SCHEDULE_TEXT');})();
export function scheduledRule(id,input,now,prior){
  const title=clean(input.title,120),prompt=clean(input.prompt,2000,true),r=input.rule;
  if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('INVALID_SCHEDULE_RULE');
  const args=[id,prompt];let record;
  try{
    if(r.kind==='at'&&prior&&['at','after'].includes(prior.kind)){const normalized=createAtScheduleRecord(...args,r.at,0,title);if(normalized.scheduledAt===prior.scheduledAt)return {...prior,title,prompt};}
    if(r.kind==='after')record=createAfterScheduleRecord(...args,r.seconds,now,title);
    else if(r.kind==='at')record=createAtScheduleRecord(...args,r.at,now,title);
    else if(r.kind==='every')record=createEveryScheduleRecord(...args,r.seconds,now,title);
    else if(r.kind==='daily')record=createDailyScheduleRecord(...args,{time:r.time,time_zone:r.timeZone},now,title);
    else if(r.kind==='weekly')record=createWeeklyScheduleRecord(...args,{time:r.time,time_zone:r.timeZone,weekdays:r.weekdays},now,title);
    else if(r.kind==='cron')record=createCronScheduleRecord(...args,{expression:r.expression,time_zone:r.timeZone},now,title);
    else throw new Error('INVALID_SCHEDULE_RULE');
  }catch(e){throw Object.assign(new Error('INVALID_SCHEDULE_RULE'),{cause:e,details:{code:e.code??'invalid_rule'}});}
  if(prior&&record.kind===prior.kind){
    const timing=o=>JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k])=>!['id','title','prompt','scheduledAt'].includes(k))));
    if(timing(record)===timing(prior)&&!['at','after'].includes(record.kind))record={...record,scheduledAt:prior.scheduledAt};
  }
  return record;
}
export function storedRule(row){return row.rule?decodeScheduleRecord(parse(row.rule)):{id:row.id,kind:'at',title:row.title||row.text.slice(0,120),prompt:row.text,scheduledAt:new Date(row.due_at).toISOString()};}
export function occurrence(row,now){
  const r=storedRule(row);
  return isRecurringScheduleRecord(r)?resolveRecurringOccurrence(r,now):{occurrenceAt:r.scheduledAt};
}
export function installTaskSchema(db){
  const cols=db.prepare('PRAGMA table_info(reminder)').all().map(c=>c.name);
  for(const [name,sql] of [['title','TEXT'],['rule','TEXT'],['mode',"TEXT NOT NULL DEFAULT 'notify'"],['version','INTEGER NOT NULL DEFAULT 1'],['max_lateness_ms','INTEGER DEFAULT 900000'],['error','TEXT']])if(!cols.includes(name))db.exec('ALTER TABLE reminder ADD COLUMN '+name+' '+sql);
  db.exec('CREATE TABLE IF NOT EXISTS reminder_delivery(agent TEXT NOT NULL,reminder TEXT NOT NULL,occurrence INTEGER NOT NULL,message_id TEXT NOT NULL,committed INTEGER NOT NULL,PRIMARY KEY(agent,reminder,occurrence));CREATE INDEX IF NOT EXISTS reminder_history ON reminder_delivery(agent,reminder,committed DESC);');
}
export function taskView(row,db){
  const rule=storedRule(row),history=db.prepare('SELECT occurrence,message_id AS messageId,committed FROM reminder_delivery WHERE agent=? AND reminder=? ORDER BY committed DESC LIMIT 1').get(row.agent,row.id)??null;
  return {id:row.id,title:rule.title,prompt:row.text,text:row.text,rule,mode:row.mode??'notify',version:row.version??1,dueAt:row.due_at,status:row.status,error:row.error??null,created:row.created,updated:row.updated,source:row.source,latePolicy:row.max_lateness_ms===null?'latest':'skip',lastDelivery:history,deliveryCount:db.prepare('SELECT count(*) AS n FROM reminder_delivery WHERE agent=? AND reminder=?').get(row.agent,row.id).n};
}
export function saveTask(store,agent,input,{source='owner-control'}={}){
  store.journal.assertAdmitted(agent);
  if(!['owner-control','owner-chat'].includes(source))throw new Error('INVALID_SCHEDULE_SOURCE');
  const updating=!!input.id,old=updating?store.db.prepare('SELECT * FROM reminder WHERE agent=? AND id=?').get(agent,input.id):null;
  if(updating&&!old)throw new Error('REMINDER_NOT_FOUND');
  if(updating&&old.version!==input.expectedVersion)throw new Error('STALE_SCHEDULE');
  if(updating&&!['pending','paused','blocked'].includes(old.status))throw new Error('SCHEDULE_NOT_EDITABLE');
  if(!['notify','prompt'].includes(input.mode)||!['latest','skip'].includes(input.latePolicy))throw new Error('INVALID_SCHEDULE_MODE');
  if(!updating&&(!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.requestId??'')))throw new Error('INVALID_REQUEST_ID');
  const maxLate=input.latePolicy==='latest'?null:900000;
  if(!updating){
    const prior=store.db.prepare('SELECT * FROM reminder WHERE agent=? AND request_id=?').get(agent,input.requestId);
    if(prior){const saved=storedRule(prior),same=scheduledRule(prior.id,input,prior.created,saved);if(JSON.stringify(same)!==JSON.stringify(saved)||prior.mode!==input.mode||prior.max_lateness_ms!==maxLate)throw new Error('REQUEST_ID_CONFLICT');return taskView(prior,store.db);}
    if(store.db.prepare("SELECT count(*) AS n FROM reminder WHERE agent=? AND status IN ('pending','paused','blocked','staged')").get(agent).n>=50)throw new Error('REMINDER_LIMIT');
  }
  const id=old?.id??crypto.randomUUID(),now=store.now(),rule=scheduledRule(id,input,now,old?storedRule(old):null),canonical=JSON.stringify(rule);
  store.journal.transaction(()=>{
    if(old)store.db.prepare("UPDATE reminder SET title=?,text=?,rule=?,mode=?,max_lateness_ms=?,due_at=?,version=version+1,error=NULL,updated=? WHERE agent=? AND id=?").run(rule.title,rule.prompt,canonical,input.mode,maxLate,Date.parse(rule.scheduledAt),now,agent,id);
    else store.db.prepare("INSERT INTO reminder(id,agent,request_id,due_at,text,status,message_id,created,updated,source,title,rule,mode,max_lateness_ms) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)").run(id,agent,input.requestId,Date.parse(rule.scheduledAt),rule.prompt,crypto.randomUUID(),now,now,source,rule.title,canonical,input.mode,maxLate);
    store.journal.audit(agent,old?'schedule-updated':'schedule-created',{scheduleId:id,title:rule.title,mode:input.mode,ruleKind:rule.kind,dueAt:Date.parse(rule.scheduledAt),version:(old?.version??0)+1});
  });
  return taskView(store.db.prepare('SELECT * FROM reminder WHERE agent=? AND id=?').get(agent,id),store.db);
}
export function toggleTask(store,agent,input){
  const row=store.db.prepare('SELECT * FROM reminder WHERE agent=? AND id=?').get(agent,input.id);if(!row)throw new Error('REMINDER_NOT_FOUND');
  if(row.version!==input.expectedVersion)throw new Error('STALE_SCHEDULE');
  if(!['pending','paused','blocked'].includes(row.status))throw new Error('SCHEDULE_NOT_EDITABLE');
  if(typeof input.enabled!=='boolean')throw new Error('INVALID_REQUEST');
  const status=input.enabled?'pending':'paused';store.journal.transaction(()=>{store.db.prepare('UPDATE reminder SET status=?,error=NULL,version=version+1,updated=? WHERE agent=? AND id=?').run(status,store.now(),agent,row.id);store.journal.audit(agent,input.enabled?'schedule-resumed':'schedule-paused',{scheduleId:row.id,title:storedRule(row).title});});
}
export function commitTask(journal,agent,c){
  const db=journal.db,row=db.prepare('SELECT * FROM reminder WHERE id=? AND agent=? AND message_id=?').get(c.id,agent,c.messageId);
  if(!row||!['pending','staged'].includes(row.status))return;
  const at=c.contactAt,occ=c.occurrenceAt??row.due_at,rule=storedRule(row),next=c.nextScheduledAt??null;
  db.prepare('INSERT OR IGNORE INTO reminder_delivery VALUES(?,?,?,?,?)').run(agent,row.id,occ,c.messageId,at);
  if(next&&isRecurringScheduleRecord(rule)){
    db.prepare("UPDATE reminder SET status='pending',rule=?,due_at=?,message_id=?,stage_id=NULL,version=version+1,error=NULL,committed_at=?,updated=? WHERE agent=? AND id=?").run(JSON.stringify({...rule,scheduledAt:next}),Date.parse(next),crypto.randomUUID(),at,at,agent,row.id);
  }else db.prepare("UPDATE reminder SET status='committed',committed_at=COALESCE(committed_at,?),version=version+1,error=NULL,updated=? WHERE id=? AND agent=?").run(at,at,row.id,agent);
  journal.audit(agent,'schedule-delivered',{scheduleId:row.id,title:rule.title,mode:row.mode,occurrenceAt:occ,messageId:c.messageId,nextAt:next?Date.parse(next):null,deliveryMeaning:'persisted-in-canonical-session'});
}
