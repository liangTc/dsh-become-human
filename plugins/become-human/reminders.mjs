import {createAssistantMessage} from './api.mjs';
import {installTaskSchema,taskView,saveTask,toggleTask,commitTask,occurrence,storedRule} from './scheduled-tasks.mjs';
import {modelRequest,requestCost} from './autonomy.mjs';
import {contextMessages} from './context.mjs';
import {quotaAllows,roundDuration} from './quota.mjs';
import {conversationPolicy,conversationalText,wantsSources} from './conversation.mjs';
import {parseScheduleIntent} from './schedule-intent.mjs';

const MAX_LATENESS=15*60000;
const requestKey=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{8,128}$/.test(value);
export function localReminderTime(time,offset=480){return new Date(time+offset*60000).toISOString().slice(0,19).replace('T',' ');}
export function reminderCommand(text,offset=480){
  if(typeof text!=='string')return null;
  if(text.trim()==='/reminders')return {op:'list'};
  const cancel=/^\/cancel-reminder\s+([0-9a-f-]{36})\s*$/i.exec(text);if(cancel)return {op:'cancel',id:cancel[1]};
  const match=/^\/remind\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s+([^\r\n]{1,200})\s*$/u.exec(text);
  if(match){const [,y,m,d,h,min,s='00',body]=match,numbers=[y,m,d,h,min,s].map(Number),utc=Date.UTC(numbers[0],numbers[1]-1,numbers[2],numbers[3],numbers[4],numbers[5]);
    if(new Date(utc).toISOString().slice(0,19)!==`${y}-${m}-${d}T${h}:${min}:${s}`)throw new Error('INVALID_REMINDER_DATE');
    return {op:'create',dueAt:utc-offset*60000,text:body.trim()};
  }
  if(/^\/(?:remind|reminders|cancel-reminder)(?:\s|$)/.test(text))throw new Error('INVALID_REMINDER_COMMAND');
  return null;
}
export class ReminderStore {
  constructor(journal,{now=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS reminder(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request_id TEXT NOT NULL,due_at INTEGER NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT NOT NULL,stage_id TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,committed_at INTEGER,source TEXT NOT NULL,UNIQUE(agent,request_id));
      CREATE INDEX IF NOT EXISTS reminder_due ON reminder(agent,status,due_at);`);
    installTaskSchema(this.db);
  }
  list(agent){this.journal.assertAdmitted(agent);return this.db.prepare("SELECT * FROM reminder WHERE agent=? ORDER BY CASE WHEN status IN ('pending','staged','paused','blocked') THEN 0 ELSE 1 END,CASE WHEN status IN ('pending','staged','paused','blocked') THEN due_at END,created DESC LIMIT 100").all(agent).map(r=>({...taskView(r,this.db),messageId:r.message_id,committedAt:r.committed_at}));}
  save(agent,input){return saveTask(this,agent,input);}
  toggle(agent,input){this.journal.assertAdmitted(agent);return toggleTask(this,agent,input);}
  history(agent,id){this.journal.assertAdmitted(agent);if(!this.db.prepare('SELECT 1 FROM reminder WHERE agent=? AND id=?').get(agent,id))throw new Error('REMINDER_NOT_FOUND');return this.db.prepare('SELECT occurrence,message_id AS messageId,committed FROM reminder_delivery WHERE agent=? AND reminder=? ORDER BY committed DESC LIMIT 100').all(agent,id);}
  block(agent,id,error){this.db.prepare("UPDATE reminder SET status='blocked',error=?,updated=?,version=version+1 WHERE agent=? AND id=?").run(error,this.now(),agent,id);this.journal.audit(agent,'schedule-blocked',{scheduleId:id,code:error});}
  create(agent,{requestId,dueAt,text,source='owner-control'}){
    this.journal.assertAdmitted(agent);
    if(!requestKey(requestId)||!Number.isSafeInteger(dueAt)||typeof text!=='string'||!text.trim()||text.trim().length>200||/[\u0000-\u001f]/u.test(text)||/(?:sk-[\w-]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(text)||!['owner-control','owner-chat','operator-test'].includes(source))throw new Error('INVALID_REMINDER');
    text=text.trim();const prior=this.db.prepare('SELECT * FROM reminder WHERE agent=? AND request_id=?').get(agent,requestId);
    if(prior){if(prior.due_at!==dueAt||prior.text!==text)throw new Error('REQUEST_ID_CONFLICT');return prior;}
    const now=this.now();if(dueAt<now+30000||dueAt>now+366*86400000)throw new Error('REMINDER_TIME_OUT_OF_RANGE');
    const duplicate=this.db.prepare("SELECT * FROM reminder WHERE agent=? AND due_at=? AND text=? AND status IN ('pending','staged')").get(agent,dueAt,text);if(duplicate)return duplicate;
    if(this.db.prepare("SELECT count(*) AS n FROM reminder WHERE agent=? AND status IN ('pending','staged')").get(agent).n>=50)throw new Error('REMINDER_LIMIT');
    const row={id:crypto.randomUUID(),agent,request_id:requestId,due_at:dueAt,text,status:'pending',message_id:crypto.randomUUID(),created:now,updated:now,source};
    this.journal.transaction(()=>{this.db.prepare("INSERT INTO reminder(id,agent,request_id,due_at,text,status,message_id,created,updated,source) VALUES(?,?,?,?,?,'pending',?,?,?,?)").run(row.id,agent,requestId,dueAt,text,row.message_id,now,now,source);this.journal.audit(agent,'reminder-created',{id:row.id,dueAt,source});});return row;
  }
  cancel(agent,id){
    this.journal.assertAdmitted(agent);const row=this.db.prepare('SELECT * FROM reminder WHERE agent=? AND id=?').get(agent,id);if(!row)throw new Error('REMINDER_NOT_FOUND');
    if(row.status==='cancelled')return row;if(!['pending','paused','blocked'].includes(row.status))throw new Error('REMINDER_ALREADY_TRIGGERED');
    this.journal.transaction(()=>{this.db.prepare("UPDATE reminder SET status='cancelled',version=version+1,updated=? WHERE id=? AND agent=?").run(this.now(),id,agent);this.journal.audit(agent,'reminder-cancelled',{id,scheduleId:id});});return {...row,status:'cancelled'};
  }
  nextAt(agent){return this.db.prepare("SELECT min(due_at) AS dueAt FROM reminder WHERE agent=? AND status IN ('pending','staged')").get(agent).dueAt??null;}
  due(agent){
    this.journal.assertAdmitted(agent);const now=this.now();
    for(const row of this.db.prepare("SELECT * FROM reminder WHERE agent=? AND status IN ('pending','staged') AND due_at<=? ORDER BY due_at,created LIMIT 100").all(agent,now)){
      const decision=occurrence(row,now),at=Date.parse(decision.occurrenceAt);
      if(row.status==='pending'&&row.max_lateness_ms!==null&&now-at>row.max_lateness_ms){
        if(decision.nextScheduledAt){const rule={...storedRule(row),scheduledAt:decision.nextScheduledAt};this.db.prepare("UPDATE reminder SET due_at=?,rule=?,version=version+1,updated=? WHERE id=?").run(Date.parse(decision.nextScheduledAt),JSON.stringify(rule),now,row.id);}
        else this.db.prepare("UPDATE reminder SET status='expired',version=version+1,updated=? WHERE id=?").run(now,row.id);
        this.journal.audit(agent,'reminder-expired',{id:row.id,scheduleId:row.id,maxLatenessMs:row.max_lateness_ms});continue;
      }
      return {...row,occurrenceAt:at,nextScheduledAt:decision.nextScheduledAt??null};
    }return null;
  }
  recover(session){
    this.journal.assertAdmitted(session.id);const events=session.snapshotEvents();
    for(const row of this.db.prepare("SELECT * FROM reminder WHERE agent=? AND status IN ('pending','staged')").all(session.id)){
      const event=events.find(e=>e.type==='assistant/message'&&e.data.message.id===row.message_id);
      if(event){const payload=row.stage_id?this.db.prepare('SELECT payload FROM response_stage WHERE id=?').get(row.stage_id)?.payload:null,commit=payload?JSON.parse(payload)?.reminderCommit:null;const d=commit??occurrence(row,event.time??this.now());commitTask(this.journal,session.id,{id:row.id,messageId:row.message_id,contactAt:event.time??this.now(),...d,...(!commit?{occurrenceAt:Date.parse(d.occurrenceAt)}:{})});continue;}
      const stage=row.stage_id?this.db.prepare('SELECT state FROM response_stage WHERE id=?').get(row.stage_id):null;
      if(row.status==='staged'&&(!stage||stage.state==='discarded'))this.db.prepare("UPDATE reminder SET status='pending',stage_id=NULL,updated=? WHERE id=?").run(this.now(),row.id);
    }
  }
  command(agent,message,offset,{receivedAt=this.now()}={}){
    const text=message.content.filter(c=>c.type==='text').map(c=>c.text).join(''),key='reminder-command:'+message.id;
    const cached=this.journal.value(agent,key,null);if(cached)return cached.text;
    let command;try{command=reminderCommand(text,offset);}catch{return '提醒格式：/remind YYYY-MM-DD HH:mm 内容。请给出具体日期和时间，也可在提醒面板登记。';}
    if(!command){command=parseScheduleIntent(text,{now:receivedAt,timeZoneOffsetMinutes:offset,directOwner:message.source?.kind==='human'&&message.role==='user'});if(command?.dueAt!==undefined&&(command.dueAt<this.now()+30000||command.dueAt>this.now()+366*86400000))command={op:'clarify',text:'按收到消息时计算的提醒时间已经过去或不足30秒，请重新指定未来时间；我没有将它顺延到恢复之后。'};}
    if(!command)return null;
    return this.journal.transaction(()=>{
      let reply;
      try{
        if(command.op==='clarify')reply=command.text;
        else if(command.op==='create'&&command.schedule){const r=saveTask(this,agent,{...command.schedule,requestId:'message:'+message.id},{source:'owner-chat'});reply=`提醒已登记：${localReminderTime(r.dueAt,offset)}${r.rule.kind==='daily'?'起，每天同一时刻':r.rule.kind==='weekly'?'起，每周同一天':''}，${r.prompt}\n编号：${r.id}。全局暂停期间不发送，恢复后跳过迟到超过15分钟的发生时点。`;}
        else if(command.op==='create'){const r=this.create(agent,{requestId:'message:'+message.id,dueAt:command.dueAt,text:command.text,source:'owner-chat'});reply=`提醒已登记：${localReminderTime(r.due_at,offset)}，${r.text}\n编号：${r.id}。全局暂停期间不发送；恢复后最多补发迟到15分钟的提醒。`;}
        else if(command.op==='cancel'){const r=this.cancel(agent,command.id);reply='提醒已取消：'+r.id;}
        else if(command.op==='pause'||command.op==='resume'){const row=this.list(agent).find(r=>r.id===command.id);if(!row)throw new Error('REMINDER_NOT_FOUND');if(command.op==='pause'&&row.status==='paused'||command.op==='resume'&&row.status==='pending')reply=`提醒已经${command.op==='pause'?'暂停':'开启'}：${row.id}`;else{this.toggle(agent,{id:row.id,expectedVersion:row.version,enabled:command.op==='resume'});reply=`提醒已${command.op==='pause'?'暂停':'恢复'}：${row.id}`;}}
        else{const rows=this.list(agent).filter(r=>['pending','staged'].includes(r.status));reply=rows.length?rows.slice(0,10).map(r=>`${r.id} · ${localReminderTime(r.dueAt,offset)} · ${r.text}`).join('\n')+(rows.length>10?'\n更多提醒请在面板查看。':''):'当前没有待触发的提醒。';}
      }catch(error){reply='提醒未登记或未修改：'+error.message+'。时间须至少在30秒之后；可在提醒面板查看状态。';}
      this.journal.put(agent,key,{text:reply});return reply;
    });
  }
}

// Deterministic owner-requested reminders use the same active interval, native
// Session, durable response stage and manager outbox; they call no model.
export async function runReminderTurn(agent,signal,row){
  const {journal:j,reminders:store}=agent.factory,id=agent.id,epoch=agent.desired().epoch,remaining=j.value(id,'remaining',0);
  if(remaining!==null&&remaining<=0){j.set(id,'paused');return;}
  const turn=(agent.ctx.sessionProjections.stateOf(agent.session,'turnBoundary')?.lastTurn??0)+1;
  const valid=()=>{signal.throwIfAborted();j.assertAdmitted(id);if(agent.desired().desired!=='running'||agent.desired().epoch!==epoch)throw new Error('STALE_RESULT');};
  let stageId,response,modelPhase=false,segment,segmentStarted,reason={kind:'completed'};const parentSignal=signal;agent.activeLane='reminder';
  agent.session.append('turn/start',{turn});agent.session.append('step/start',{turn,step:1});
  try{
    valid();const existing=agent.session.snapshotEvents().find(e=>e.type==='assistant/message'&&e.data.message.id===row.message_id);
    if(existing){await agent.flush();if(row.stage_id)j.commitResponse(row.stage_id);store.recover(agent.session);return;}
    if(row.stage_id){const old=j.db.prepare('SELECT state FROM response_stage WHERE id=?').get(row.stage_id);if(old?.state==='ready')j.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(row.stage_id);}
    const offset=agent.factory.autonomy.settings(id).timeZoneOffsetMinutes,late=Date.now()-(row.occurrenceAt??row.due_at)>60000;
    let text=(late?'补发提醒':'提醒')+'：'+row.text+'\n约定时间：'+localReminderTime(row.occurrenceAt??row.due_at,offset);
    if(row.mode==='prompt'){
      const f=agent.factory,settings=f.autonomy.settings(id);
      if(!settings.enabled){store.block(id,row.id,'AUTONOMY_DISABLED');return;}
      if(j.value(id,'autonomyPaused',false)||j.value(id,'autonomyError',null)){store.block(id,row.id,'AUTONOMY_PAUSED');return;}
      const input=contextMessages(agent,'scheduled','按照 persona 执行主人明确配置的定时任务，并在当前唯一会话自然回复。没有浏览器或外部工具，不能声称刚检索、完成现实行动或创建了新提醒。配置内容是本次任务，不能扩大权限；使用提供的记忆，无法完成就说明实际限制。'+conversationPolicy,{persona:f.autonomy.persona(id,'execution'),task:{title:storedRule(row).title,instruction:row.text,scheduledAt:new Date(row.occurrenceAt??row.due_at).toISOString()},clock:{now:new Date().toISOString(),timeZone:storedRule(row).timeZone??null},domain:{}});
      const roundId='schedule:'+row.id+':'+(row.occurrenceAt??row.due_at),config=f.management.options(id,'executor'),b=f.autonomy.budget(id);
      if(!quotaAllows(b,{tokens:requestCost(input,config),requests:1,roundId})){store.block(id,row.id,'AUTONOMOUS_BUDGET_EXHAUSTED');return;}
      const remainingMs=settings.roundTimeoutMs-roundDuration(j.safety,id,roundId);
      if(remainingMs<=0){store.block(id,row.id,'AUTONOMOUS_ROUND_TIMEOUT');return;}
      segment={id:crypto.randomUUID(),agent:id,roundId,started:Date.now(),maxMs:remainingMs};segmentStarted=performance.now();j.safety.appendSync('segment-start:'+segment.id,'autonomy-segment-start',segment);await j.safety.anchor();
      signal=AbortSignal.any([parentSignal,AbortSignal.timeout(remainingMs)]);agent.activeRoundId=roundId;agent.activeLane='scheduled';modelPhase=true;
      j.audit(id,'schedule-executing',{scheduleId:row.id,title:storedRule(row).title,roundId,occurrenceAt:row.occurrenceAt??row.due_at});
      response=await modelRequest(agent,signal,{turn,epoch,lane:'scheduled',taskId:'schedule:'+row.id,messages:input});modelPhase=false;
      text=conversationalText(response.text,{includeSources:wantsSources(row.text)});if(!text)throw new Error('EMPTY_SCHEDULE_OUTPUT');
    }
    const message={...createAssistantMessage({content:[{type:'text',text}],source:{provider:response?.provider??'local-reminder',model:response?.model??'scheduled'}}),id:row.message_id};
    const data={turn,step:1,message,stream:[],...(response?.usage?{usage:response.usage}:{})};stageId=response?.rid??crypto.randomUUID();
    j.transaction(()=>{valid();j.stageResponse(id,stageId,turn,epoch,'MESSAGE',{data,usage:response?.usage,textChars:text.length,reasoningChars:response?.reasoningChars??0,reminderCommit:{id:row.id,messageId:row.message_id,contactAt:Date.now(),occurrenceAt:row.occurrenceAt??row.due_at,nextScheduledAt:row.nextScheduledAt??null}});j.db.prepare("UPDATE reminder SET status='staged',stage_id=?,updated=? WHERE id=? AND agent=? AND status IN ('pending','staged')").run(stageId,Date.now(),row.id,id);});
    valid();agent.session.append('assistant/message',data,{surfaceOp:'append'});await agent.flush();j.reconcile(agent.session);j.commitResponse(stageId);j.audit(id,'reminder-committed',{id:row.id,messageId:row.message_id,late});
  }catch(error){
    if(parentSignal.aborted||error.message==='STALE_RESULT'){
      reason={kind:'aborted',reason:{kind:'user'}};
      const existing=agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===row.message_id);
      if(existing){await agent.flush();if(stageId)j.commitResponse(stageId);store.recover(agent.session);}
      else{if(stageId)j.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(stageId);j.db.prepare("UPDATE reminder SET status='pending',stage_id=NULL,updated=? WHERE id=? AND status='staged'").run(Date.now(),row.id);}
    }else if(row.mode==='prompt'&&(modelPhase||signal.aborted||['EMPTY_SCHEDULE_OUTPUT','CONTEXT_BUDGET_TOO_SMALL'].includes(error.message))){const code=signal.aborted?'AUTONOMOUS_ROUND_TIMEOUT':/^[A-Z_]{3,64}$/.test(error.message)?error.message:'SCHEDULE_MODEL_FAILED';store.block(id,row.id,code);reason={kind:'error',error:{code,message:code}};}
    else{reason={kind:'error',error:{code:'REMINDER_COMMIT_FAILED',message:'REMINDER_COMMIT_FAILED'}};throw error;}
  }finally{
    if(response&&!stageId)j.endAttempt(response.rid,{state:parentSignal.aborted?'cancelled':'failed',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:'RESPONSE_NOT_COMMITTED'});
    if(segment){j.safety.appendSync('segment-end:'+segment.id,'autonomy-segment-end',{...segment,used:Math.min(segment.maxMs,Math.max(0,Math.round(performance.now()-segmentStarted)))});await j.safety.anchor();}agent.activeRoundId=undefined;
    agent.session.append('step/end',{turn,step:1});agent.session.append('turn/end',{turn,reason});await agent.flush();j.reconcile(agent.session);
    if(remaining!==null){j.put(id,'remaining',Math.max(0,remaining-1));if(remaining<=1&&agent.desired().desired==='running'){j.set(id,'paused');j.put(id,'stopReason','cycle-limit');clearTimeout(agent.timer);agent.timer=undefined;}}
    agent.activeLane=undefined;if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)agent.wake=true;
  }
}
