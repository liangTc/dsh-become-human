import {randomUUID,createHash} from 'node:crypto';
import {researchUrl} from './learning.mjs';
import {goalAcceptance,goalSupport,evaluateGoal} from './goal-support.mjs';

const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const fail=code=>{throw new Error(code);};
const clean=(value,max)=>typeof value==='string'&&value.trim()&&value.trim().length<=max?value.trim():fail('INVALID_GOAL');
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/i.test(value);
const ended=new Set(['cancelled','expired']);
function directionQuestion(value){
  if(typeof value!=='string')return '';
  let text=value.normalize('NFKC').replace(/\s+/gu,' ').trim();
  // A follow-up note can carry this module's own bounded research question.
  // Unwrap only this exact template, never an arbitrary owner's instruction.
  for(let n=0;n<6;n++){const match=/^核对[“"]([\s\S]+)[”"]的适用边界[，,]并寻找一个独立来源进行比较[。.]?$/u.exec(text);if(!match)break;text=match[1].trim();}
  return text.replace(/[。？！?!]+$/u,'').trim();
}
const directionKey=value=>createHash('sha256').update(directionQuestion(value).toLowerCase().replace(/[\s“”"'‘’、，,；;：:（）()【】\[\]？?!！。]/gu,'')).digest('hex');
const sameIds=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&new Set(a).size===a.length&&new Set(b).size===b.length&&[...a].sort().every((id,n)=>id===[...b].sort()[n]);

// Durable finite research and local-report objectives. The existing driver
// claims every task/action in its one lane; this store starts no model loop.
// A proposal grants no authority: only a management/user activation can make it
// eligible, and every dispatch still consults the current signed settings.
export class GoalEngine {
  constructor(journal,domain,autonomy,{clock=()=>Date.now(),actions=null}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.autonomy=autonomy;this.clock=clock;this.actions=actions;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_goal_plan(agent TEXT,goal TEXT PRIMARY KEY,steps TEXT,origin_note TEXT,created INTEGER,updated INTEGER,reason TEXT,retry_at INTEGER,evaluation TEXT);
      CREATE INDEX IF NOT EXISTS human_goal_agent ON human_goal_plan(agent,created);`);
  }
  setActions(actions){this.actions=actions;return this;}
  now(agent){return Math.max(this.clock(),this.journal.value(agent,'goalTimeHighWater',0));}
  checkpointTime(agent){const now=this.now(agent);this.journal.put(agent,'goalTimeHighWater',now);return now;}
  raw(agent,id){if(typeof id!=='string'||!id||id.length>128)fail('GOAL_NOT_FOUND');const row=this.db.prepare('SELECT g.*,p.steps,p.origin_note,p.created,p.updated,p.reason,p.retry_at,p.evaluation FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id AND p.agent=g.agent WHERE g.agent=? AND g.id=?').get(agent,id);if(!row)fail('GOAL_NOT_FOUND');const saved=this.journal.value(agent,'goalSupport:'+id,null);return {...row,refs:parse(row.refs)??[],steps:parse(row.steps)??[],evaluation:parse(row.evaluation),support:goalSupport(saved??{},!saved||saved.version===1)};}
  linked(agent,taskId){if(typeof taskId!=='string'||!taskId||taskId.length>128)return undefined;return this.db.prepare("SELECT p.goal FROM human_goal_plan p WHERE p.agent=? AND EXISTS(SELECT 1 FROM json_tree(p.steps) t WHERE t.key='taskId' AND t.value=?) LIMIT 1").get(agent,taskId);}
  refsUsable(agent,refs){return Array.isArray(refs)&&refs.length>0&&refs.every(ref=>{const s=this.db.prepare("SELECT * FROM source_record WHERE agent=? AND id=? AND status='active'").get(agent,ref);return s&&s.namespace==='real'&&this.domain.sourceUsable(agent,ref);});}
  sourceValid(row){return this.refsUsable(row.agent,row.refs)&&(!row.origin_note||!!this.validNote(row.agent,row.origin_note))&&row.steps.every(s=>s.kind!=='write-report'||!s.noteIds||s.noteIds.every(id=>!!this.validNote(row.agent,id)));}
  save(row,kind,data={}){
    this.db.prepare('UPDATE goal_record SET status=?,version=version+1 WHERE agent=? AND id=?').run(row.status,row.agent,row.id);
    this.db.prepare('UPDATE human_goal_plan SET steps=?,updated=?,reason=?,retry_at=?,evaluation=? WHERE agent=? AND goal=?').run(JSON.stringify(row.steps),this.checkpointTime(row.agent),row.reason??null,row.retry_at??null,JSON.stringify(row.evaluation??null),row.agent,row.id);
    this.journal.put(row.agent,'goalSupport:'+row.id,row.support);
    this.journal.audit(row.agent,kind,{goalId:row.id,goalVersion:row.version+1,status:row.status,...data});
  }
  propose(agent,{description,refs,expires,milestones,originNote=null,priority=3,expectedValue='',acceptance,origin='owner-plan'}){
    this.journal.assertAdmitted(agent);const now=this.checkpointTime(agent);description=clean(description,512);
    const support=goalSupport({priority,expectedValue,acceptance,origin});
    if(secret(description)||!Number.isSafeInteger(expires)||expires<=now||expires>now+90*86400000||!this.refsUsable(agent,refs)||!Array.isArray(milestones)||milestones.length<1||milestones.length>6)fail('INVALID_GOAL');
    const steps=milestones.map((m,index)=>{if(!m||!['research','learn-ai','write-report'].includes(m.kind)||Object.keys(m).some(k=>!['kind','question','sourceUrl','noteIds'].includes(k)))fail('INVALID_GOAL_MILESTONE');const question=clean(m.question,240);if(secret(question)||m.kind!=='learn-ai'&&m.sourceUrl!==undefined||m.kind!=='write-report'&&m.noteIds!==undefined)fail('INVALID_GOAL_MILESTONE');
      if(m.kind==='write-report'){if(m.noteIds!==undefined&&(!Array.isArray(m.noteIds)||!m.noteIds.length||m.noteIds.length>8||new Set(m.noteIds).size!==m.noteIds.length||!m.noteIds.every(id=>typeof id==='string'&&!!this.validNote(agent,id))))fail('INVALID_GOAL_REPORT_NOTES');if(m.noteIds===undefined&&!milestones.slice(0,index).some(s=>['research','learn-ai'].includes(s?.kind)))fail('GOAL_REPORT_REQUIRES_NOTES');}
      return {id:randomUUID(),kind:m.kind,question,...(m.kind==='learn-ai'?{sourceUrl:researchUrl(m.sourceUrl)}:{}),...(m.kind==='write-report'?{actionId:null,...(m.noteIds?{noteIds:[...m.noteIds]}:{})}:{}),status:'pending',taskId:null,noteId:null,attempts:[]};});
    if(new Set(steps.map(s=>s.kind+':'+s.question+':'+(s.sourceUrl??'')+':'+JSON.stringify(s.noteIds??null))).size!==steps.length)fail('DUPLICATE_GOAL_MILESTONE');
    if(originNote!==null){const note=this.validNote(agent,originNote);if(!note)fail('INVALID_GOAL_ORIGIN');const old=this.db.prepare('SELECT goal FROM human_goal_plan WHERE agent=? AND origin_note=?').get(agent,originNote);if(old)return this.get(agent,old.goal);}
    if(this.db.prepare("SELECT count(*) AS n FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id WHERE g.agent=? AND g.status IN ('proposed','active','blocked','paused','needs-evidence','awaiting-review') AND g.expires>?").get(agent,now).n>=8)fail('GOAL_LIMIT');
    return this.journal.transaction(()=>{const id=this.domain.goal(agent,{description,refs,expires});this.db.prepare('INSERT INTO human_goal_plan VALUES(?,?,?,?,?,?,NULL,NULL,NULL)').run(agent,id,JSON.stringify(steps),originNote,now,now);this.journal.put(agent,'goalSupport:'+id,support);this.journal.audit(agent,'goal-proposed',{goalId:id,steps:steps.length,originNote,priority,expectedValue:support.expectedValue,acceptance:support.acceptance,origin});return this.get(agent,id);});
  }
  proposeFromNote(agent,note,{enabled=false}={}){
    if(enabled!==true)return null;const id=typeof note==='string'?note:note?.id,record=id&&this.validNote(agent,id);if(!record)return null;
    const d=record.data,question=directionQuestion(typeof d.researchQuestion==='string'&&d.researchQuestion.trim()?d.researchQuestion:d.title);if(!question||question.length>180||secret(question))return null;
    const key=directionKey(question),now=this.now(agent);
    for(const r of this.db.prepare("SELECT g.id FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id AND p.agent=g.agent WHERE g.agent=? AND p.origin_note IS NOT NULL ORDER BY CASE WHEN g.status IN ('proposed','active','blocked','paused') THEN 0 ELSE 1 END,p.created DESC LIMIT 256").all(agent)){
      const row=this.raw(agent,r.id),step=row.steps[0];if(!step||step.kind!=='research'||!this.sourceValid(row)||directionKey(step.question)!==key)continue;
      const current=['proposed','active','blocked','paused','needs-evidence','awaiting-review'].includes(row.status)&&row.expires>now;
      const cooled=['completed','cancelled','expired'].includes(row.status)&&now-row.updated<7*86400000;
      if(current||cooled){this.journal.audit(agent,'goal-proposal-deduplicated',{goalId:row.id,noteId:id,directionKey:key,scope:current?'existing-direction':'recent-terminal-direction'});return this.get(agent,row.id);}
    }
    // A note's conversation question is deliberately not used as a goal.
    const proposal=this.propose(agent,{description:('进一步核对：'+question).slice(0,512),refs:[record.source_id],expires:this.now(agent)+7*86400000,originNote:id,origin:'learning-note',expectedValue:'比较独立公开来源，补充这条已学习结论的适用边界。',acceptance:{minNotes:2,minIndependentSources:2,ownerReview:true},milestones:[{kind:'research',question:('核对“'+question+'”的适用边界，并寻找一个独立来源进行比较。').slice(0,240)}]});
    return this.autoActivate(agent,proposal);
  }
  autoActivate(agent,proposal){const settings=this.autonomy.settings(agent);if(settings.goalAutoActivateEnabled!==true||proposal.status!=='proposed'||!proposal.sourceValid||!proposal.steps.every(s=>['research','learn-ai'].includes(s.kind)&&this.eligible(agent,s,settings)))return proposal;return this.transition(agent,proposal.id,'activate',{expectedVersion:proposal.version});}
  proposeFromGap(agent,{question,refs,expectedValue='',priority=3,acceptance},{enabled=false}={}){
    this.journal.assertAdmitted(agent);if(enabled!==true)return null;question=clean(question,180);
    const normalized=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    if(!normalized(question))fail('INVALID_GOAL');
    if(!this.refsUsable(agent,refs)||!refs.every(ref=>{const source=this.db.prepare("SELECT kind,root,id FROM source_record WHERE agent=? AND id=? AND status='active'").get(agent,ref);return source?.kind==='user'&&source.root===source.id;})||!refs.some(ref=>normalized(this.db.prepare('SELECT body FROM source_record WHERE agent=? AND id=?').get(agent,ref)?.body).includes(normalized(question))))fail('GOAL_GAP_REQUIRES_OWNER_SOURCE');
    const existing=this.list(agent,{limit:128}).find(g=>g.sourceValid&&!['cancelled','expired','completed'].includes(g.status)&&g.steps.some(s=>directionKey(s.question)===directionKey(question)));if(existing)return existing;
    return this.autoActivate(agent,this.propose(agent,{description:'补充已确认的知识缺口：'+question,refs,expires:this.now(agent)+7*86400000,priority,expectedValue:expectedValue||'为主人明确指出的问题补充可核对的公开来源与学习笔记。',acceptance:acceptance??{minNotes:1,minIndependentSources:1,requiredQuestions:[question],ownerReview:true},origin:'owner-gap',milestones:[{kind:'research',question}]}));
  }
  version(row,expectedVersion){if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==row.version)fail('STALE_GOAL');}
  transition(agent,id,action,{expectedVersion}={}){
    this.journal.assertAdmitted(agent);this.reconcile(agent,id);const row=this.raw(agent,id);this.version(row,expectedVersion);
    if(!['activate','pause','cancel'].includes(action))fail('INVALID_GOAL_ACTION');
    if(ended.has(row.status)||row.status==='completed')fail('GOAL_FINAL');
    if(action==='cancel')row.status='cancelled';
    else if(action==='pause'){if(!['active','blocked'].includes(row.status))fail('INVALID_GOAL_TRANSITION');row.status='paused';}
    else {if(!this.sourceValid(row))fail('GOAL_SOURCE_INVALID');if(row.status==='blocked'||row.steps.some(s=>s.status==='failed'))fail('GOAL_RETRY_REQUIRED');if(!['proposed','paused'].includes(row.status))fail('INVALID_GOAL_TRANSITION');row.status='active';row.reason=null;}
    this.journal.transaction(()=>this.save(row,'goal-'+action));return this.get(agent,id);
  }
  eligible(agent,step,settings){
    if(!settings.enabled)return false;if(step.kind==='write-report')return !!this.actions;
    if(!settings.learningEnabled)return false;
    if(step.kind==='research')return settings.searchEnabled===true;
    return settings.sources?.some(s=>s.url===step.sourceUrl)===true;
  }
  reportNotes(row,step){
    const ids=step.noteIds??row.steps.slice(0,row.steps.findIndex(s=>s.id===step.id)).filter(s=>['research','learn-ai'].includes(s.kind)&&s.status==='completed').map(s=>s.noteId);
    return [...new Set(ids.filter(Boolean))];
  }
  reportSourcesValid(row,step){const ids=step.resolvedNoteIds??this.reportNotes(row,step);return ids.length>0&&ids.length<=8&&ids.every(id=>!!this.validNote(row.agent,id))&&sameIds(ids,this.reportNotes(row,step));}
  reportAction(agent,id){if(!this.actions||typeof this.actions.get!=='function')return null;try{return this.actions.get(agent,id);}catch{return null;}}
  reportMatches(row,step,action){return !!action&&(!step.actionId||action.id===step.actionId)&&action.agent===row.agent&&action.kind==='write-report'&&action.goal?.id===row.id&&action.goal?.stepId===step.id&&action.title===step.question&&sameIds(action.noteIds,step.resolvedNoteIds??this.reportNotes(row,step));}
  reportCompleted(row,step){
    const action=step.actionId&&this.reportAction(row.agent,step.actionId);if(!this.reportSourcesValid(row,step)||!this.reportMatches(row,step,action)||action.status!=='completed')return false;
    const receipt=action.receipt,verify=this.actions?.verifyCompleted??this.actions?.verifyReceipt;if(!receipt||!/^[a-f0-9]{64}$/iu.test(receipt.sha256??receipt.digest??'')||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<1||typeof receipt.path!=='string'||!receipt.path||typeof verify!=='function'||step.status==='completed'&&step.receipt&&(step.receipt.sha256!==(receipt.sha256??receipt.digest)||step.receipt.bytes!==receipt.bytes||step.receipt.path!==receipt.path))return false;
    try{return verify.call(this.actions,row.agent,action.id)===true;}catch{return false;}
  }
  completeStep(row,step,{noteId=null,action=null}={}){
    step.status='completed';step.completedAt=this.now(row.agent);delete step.error;if(noteId)step.noteId=noteId;
    if(action)step.receipt={sha256:action.receipt.sha256??action.receipt.digest,bytes:action.receipt.bytes,path:action.receipt.path,completedAt:action.receipt.completedAt??this.now(row.agent)};
    const attempt=step.attempts.findLast(a=>action?a.actionId===action.id:a.taskId===step.taskId);if(attempt){attempt.status='completed';attempt.ended=this.now(row.agent);if(noteId)attempt.noteId=noteId;if(action)attempt.sha256=step.receipt.sha256;}
    this.evaluate(row);row.retry_at=null;this.save(row,row.status==='completed'?'goal-completed':row.evaluation.executionComplete?'goal-evidence-evaluated':'goal-progress',{stepId:step.id,taskId:step.taskId,actionId:step.actionId??null,noteId:step.noteId,sha256:step.receipt?.sha256??null,completedSteps:row.steps.filter(s=>s.status==='completed').length,totalSteps:row.steps.length,unmet:row.evaluation.unmet});
  }
  evidenceNotes(row){const ids=[...(row.origin_note?[row.origin_note]:[]),...row.steps.filter(s=>s.status==='completed').flatMap(s=>s.kind==='write-report'?(s.resolvedNoteIds??s.noteIds??[]):s.noteId?[s.noteId]:[])];return [...new Set(ids)].map(id=>this.validNote(row.agent,id)).filter(Boolean);}
  evaluate(row){row.evaluation=evaluateGoal(row,this.evidenceNotes(row),this.now(row.agent));if(row.evaluation.executionComplete){row.status=row.evaluation.achieved?'completed':!row.evaluation.evidenceSatisfied||row.support.review?.accepted===false?'needs-evidence':'awaiting-review';row.reason=row.status==='completed'?null:row.status==='awaiting-review'?'goal-owner-review-required':row.support.review?.accepted===false?'goal-owner-review-rejected':'goal-acceptance-unmet';}else row.reason=null;return row.evaluation;}
  validNote(agent,id,taskId=null){
    const r=this.db.prepare("SELECT n.*,m.status AS memory_status,m.valid_to,m.refs AS memory_refs FROM learning_note n JOIN memory_record m ON m.id=n.memory_id AND m.agent=n.agent WHERE n.agent=? AND n.id=? AND n.status='active' AND m.status='active'").get(agent,id);
    if(!r||r.valid_to!==null&&r.valid_to<=this.now(agent)||!this.refsUsable(agent,[r.source_id]))return null;
    const data=parse(r.data),refs=parse(r.memory_refs);if(!data||taskId&&data.taskId!==taskId||!Array.isArray(refs)||!refs.includes(r.source_id)||!data.source?.digest||!data.source?.url||!Array.isArray(data.claims)||!data.claims.length)return null;
    if(!data.claims.every(c=>typeof c.text==='string'&&c.text.trim()&&typeof c.quote==='string'&&c.quote.length>=8))return null;
    try{researchUrl(data.source.url);}catch{return null;}
    return {...r,data};
  }
  block(row,reason,step=null){
    reason=typeof reason==='string'&&/^[A-Za-z0-9_:.-]{1,120}$/.test(reason)?reason:'goal-task-failed';
    row.status='blocked';row.reason=reason;row.evaluation=null;
    if(step){step.status='failed';step.error=reason;const attempt=step.attempts.findLast(a=>step.actionId?a.actionId===step.actionId:a.taskId===step.taskId);if(attempt){attempt.status='failed';attempt.reason=reason;attempt.ended=this.now(row.agent);}}
    const interval=this.autonomy.settings(row.agent).sourceIntervalMs??3600000;row.retry_at=this.now(row.agent)+Math.min(86400000,Math.max(600000,interval));
    this.save(row,'goal-blocked',{reason,stepId:step?.id,taskId:step?.taskId,actionId:step?.actionId??null,retryAt:row.retry_at});
  }
  reconcile(agent,id=null){
    this.journal.assertAdmitted(agent);const ids=id?[id]:this.db.prepare("SELECT p.goal FROM human_goal_plan p JOIN goal_record g ON g.id=p.goal AND g.agent=p.agent WHERE p.agent=? AND g.status NOT IN ('cancelled','expired') ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 WHEN 'paused' THEN 2 WHEN 'proposed' THEN 3 ELSE 4 END,p.created DESC LIMIT 128").all(agent).map(r=>r.goal);
    for(const goalId of ids)this.journal.transaction(()=>{
      const row=this.raw(agent,goalId);if(ended.has(row.status))return;
      if(!this.sourceValid(row)){if(row.status!=='blocked'||row.reason!=='goal-source-invalid')this.block(row,'goal-source-invalid');return;}
      if(row.expires<=this.now(agent)){row.status='expired';row.reason='goal-expired';row.evaluation=null;this.save(row,'goal-expired');return;}
      // Completed evidence stays subject to forgetting/correction after success.
      for(const step of row.steps)if(step.status==='completed'&&!(step.kind==='write-report'?this.reportCompleted(row,step):this.validNote(agent,step.noteId,step.taskId))){this.block(row,'goal-evidence-invalid',step);return;}
      if(row.steps.every(s=>s.status==='completed')&&['active','completed','needs-evidence','awaiting-review'].includes(row.status)){const before={status:row.status,basis:row.evaluation?.basis,achieved:row.evaluation?.achieved};this.evaluate(row);if(before.status!==row.status||before.basis!==row.evaluation.basis||before.achieved!==row.evaluation.achieved)this.save(row,'goal-evidence-evaluated',{unmet:row.evaluation.unmet});return;}
      if(row.status!=='active')return;
      const step=row.steps.find(s=>s.status!=='completed');if(!step)return;
      if(step.kind==='write-report'){
        if(!step.actionId)return;const action=this.reportAction(agent,step.actionId);
        if(!action||!this.reportMatches(row,step,action)||!this.reportSourcesValid(row,step)){this.block(row,'goal-report-action-invalid',step);return;}
        if(['blocked','cancelled','expired'].includes(action.status)){this.block(row,'goal-action-'+action.status,step);return;}
        if(action.status==='completed'){if(!this.reportCompleted(row,step)){this.block(row,'goal-report-receipt-invalid',step);return;}this.completeStep(row,step,{action});return;}
        if(!['proposed','approved','executing'].includes(action.status)){this.block(row,'goal-action-state-invalid',step);return;}
        const status=action.status==='executing'?'running':'awaiting-approval';if(step.status!==status){step.status=status;this.save(row,'goal-action-progress',{stepId:step.id,actionId:action.id,actionStatus:action.status});}return;
      }
      if(!step.taskId)return;
      const task=this.autonomy.getTask(step.taskId);
      if(!task||task.agent!==agent||task.kind!==step.kind){this.block(row,'goal-task-missing',step);return;}
      if(['failed','cancelled'].includes(task.status)){this.block(row,task.checkpoint?.reason??'goal-task-'+task.status,step);return;}
      if(task.status!=='completed')return;
      const noteId=task.checkpoint?.noteId??this.db.prepare("SELECT id FROM learning_note WHERE agent=? AND status='active' AND json_extract(data,'$.taskId')=? ORDER BY created DESC LIMIT 1").get(agent,task.id)?.id;
      const note=noteId&&this.validNote(agent,noteId,task.id);if(!note||step.kind==='learn-ai'&&(note.data.source.requestedUrl??note.data.source.url)!==step.sourceUrl){this.block(row,'goal-task-no-evidence',step);return;}
      this.completeStep(row,step,{noteId:note.id});
    });return id?this.get(agent,id):this.list(agent);
  }
  candidate(agent,settings=this.autonomy.settings(agent),now=this.now(agent)){
    this.reconcile(agent);const turn=this.journal.value(agent,'goalSelectionTurn',0),rows=this.list(agent,{status:'active',limit:8}).sort((a,b)=>{const x=a.scheduling,y=b.scheduling,ax=turn-x.lastTurn>=16,ay=turn-y.lastTurn>=16;return Number(ay)-Number(ax)||(ax&&ay?x.lastTurn-y.lastTurn:0)||x.virtualRuntime-y.virtualRuntime||b.priority-a.priority||a.created-b.created;});
    for(const row of rows){if(row.expires<=now||!row.sourceValid)continue;const step=row.steps.find(s=>s.status!=='completed');if(!step||step.status!=='pending'||step.taskId||!this.eligible(agent,step,settings))continue;
      if(step.kind==='write-report'){const raw=this.raw(agent,row.id),noteIds=this.reportNotes(raw,step);if(!noteIds.length||noteIds.length>8||!noteIds.every(id=>!!this.validNote(agent,id))){this.journal.transaction(()=>this.block(raw,'goal-report-sources-missing',raw.steps.find(s=>s.id===step.id)));continue;}return {kind:'write-report',question:step.question,title:step.question,noteIds,requestId:'goal-report:'+row.id+':'+step.id+':'+step.attempts.length,goal:{id:row.id,stepId:step.id,version:row.version}};}
      const sourceSpec=step.kind==='learn-ai'?settings.sources.find(s=>s.url===step.sourceUrl):null;
      return {kind:step.kind,question:step.question,goal:{id:row.id,stepId:step.id,version:row.version},...(sourceSpec?{sourceSpec:{url:sourceSpec.url,title:sourceSpec.title,topic:step.question}}:{})};
    }return null;
  }
  attachTask(agent,ref,taskId){
    this.journal.assertAdmitted(agent);this.reconcile(agent,ref?.id);const row=this.raw(agent,ref?.id),task=this.autonomy.getTask(taskId);this.version(row,ref?.version);
    const step=row.steps.find(s=>s.id===ref?.stepId);if(row.status!=='active'||!step||step.kind==='write-report'||step!==row.steps.find(s=>s.status!=='completed')||step.status!=='pending'||step.taskId||!task||task.agent!==agent||task.kind!==step.kind||task.checkpoint?.candidate?.question!==step.question||step.kind==='learn-ai'&&(task.checkpoint.source?.requestedUrl??task.checkpoint.source?.url)!==step.sourceUrl||!['ready','suspended','waiting-budget'].includes(task.status)||!this.eligible(agent,step,this.autonomy.settings(agent)))fail('GOAL_TASK_NOT_ELIGIBLE');
    if(this.linked(agent,task.id))fail('GOAL_TASK_ALREADY_LINKED');
    step.status='running';step.taskId=task.id;step.attempts.push({taskId:task.id,status:'running',started:this.now(agent)});this.journal.transaction(()=>{this.recordDispatch(row);this.save(row,'goal-task-attached',{stepId:step.id,taskId:task.id});});return this.get(agent,row.id);
  }
  attachAction(agent,ref,actionId){
    this.journal.assertAdmitted(agent);this.reconcile(agent,ref?.id);const row=this.raw(agent,ref?.id),action=this.reportAction(agent,actionId);this.version(row,ref?.version);
    const step=row.steps.find(s=>s.id===ref?.stepId);if(row.status!=='active'||!step||step.kind!=='write-report'||step!==row.steps.find(s=>s.status!=='completed')||step.status!=='pending'||step.taskId||step.actionId||!this.eligible(agent,step,this.autonomy.settings(agent))||!this.reportMatches(row,step,action)||!['proposed','approved'].includes(action.status)||!this.reportSourcesValid(row,step))fail('GOAL_ACTION_NOT_ELIGIBLE');
    if(this.db.prepare("SELECT p.goal FROM human_goal_plan p WHERE p.agent=? AND EXISTS(SELECT 1 FROM json_tree(p.steps) t WHERE t.key='actionId' AND t.value=?) LIMIT 1").get(agent,actionId))fail('GOAL_ACTION_ALREADY_LINKED');
    step.actionId=action.id;step.resolvedNoteIds=[...action.noteIds];step.status='awaiting-approval';step.attempts.push({actionId:action.id,status:'awaiting-approval',started:this.now(agent)});this.journal.transaction(()=>{this.recordDispatch(row);this.save(row,'goal-action-attached',{stepId:step.id,actionId:action.id,noteIds:step.resolvedNoteIds});});return this.get(agent,row.id);
  }
  recordDispatch(row){const turn=this.journal.value(row.agent,'goalSelectionTurn',0)+1;this.journal.put(row.agent,'goalSelectionTurn',turn);row.support.schedule={virtualRuntime:row.support.schedule.virtualRuntime+(6-row.support.priority),lastTurn:turn,lastSelectedAt:this.now(row.agent)};}
  // ActionStore calls this before proposal/approval and immediately before
  // the managed file commit. Do not reconcile or verify a file here: either
  // would recurse into ActionStore's own source/goal checks.
  actionAllowed(agent,action){
    if(!action?.goal)return true;let row;try{row=this.raw(agent,action.goal.id);}catch{return false;}
    const step=row.steps.find(s=>s.id===action.goal.stepId);if(row.status!=='active'||row.expires<=this.now(agent)||!this.sourceValid(row)||!step||step.kind!=='write-report'||step!==row.steps.find(s=>s.status!=='completed')||!this.eligible(agent,step,this.autonomy.settings(agent))||!this.reportMatches(row,step,action)||!this.reportSourcesValid(row,step))return false;
    if(!step.actionId)return step.status==='pending'&&['proposed',undefined].includes(action.status);
    return step.actionId===action.id&&['awaiting-approval','running'].includes(step.status)&&['proposed','approved','executing'].includes(action.status);
  }
  deferCandidate(agent,ref,reason='goal-source-unavailable'){
    this.journal.assertAdmitted(agent);this.reconcile(agent,ref?.id);const row=this.raw(agent,ref?.id);this.version(row,ref?.version);const step=row.steps.find(s=>s.id===ref?.stepId);
    if(row.status!=='active'||!step||step!==row.steps.find(s=>s.status!=='completed')||step.status!=='pending'||step.taskId)fail('GOAL_TASK_NOT_ELIGIBLE');
    this.journal.transaction(()=>this.block(row,reason,step));return this.get(agent,row.id);
  }
  taskAllowed(agent,task){
    const id=task?.checkpoint?.goal?.id??this.linked(agent,task?.id??'')?.goal;if(!id)return true;
    let row;try{row=this.raw(agent,id);}catch{return false;}const step=row.steps.find(s=>s.taskId===task.id);return row.status==='active'&&row.expires>this.now(agent)&&this.sourceValid(row)&&!!step&&step.status==='running'&&step.kind===task.kind&&this.eligible(agent,step,this.autonomy.settings(agent));
  }
  failed(agent,taskId){const row=this.linked(agent,taskId);return row?this.reconcile(agent,row.goal):null;}
  retry(agent,id,{expectedVersion}={}){
    this.journal.assertAdmitted(agent);this.reconcile(agent,id);const row=this.raw(agent,id);this.version(row,expectedVersion);
    if(!['blocked','paused'].includes(row.status)||!this.sourceValid(row))fail('GOAL_NOT_RETRYABLE');
    if(row.retry_at&&row.retry_at>this.now(agent))fail('GOAL_BACKOFF');
    const step=row.steps.find(s=>s.status==='failed');if(!step)fail('GOAL_NOT_RETRYABLE');if(step.attempts.length>=16)fail('GOAL_ATTEMPT_LIMIT');
    step.status='pending';step.taskId=null;step.noteId=null;if(step.kind==='write-report'){step.actionId=null;delete step.resolvedNoteIds;delete step.receipt;}delete step.error;row.status='active';row.reason=null;row.retry_at=null;row.evaluation=null;this.journal.transaction(()=>this.save(row,'goal-retry-authorized',{stepId:step.id,priorTaskId:step.attempts.at(-1)?.taskId,priorActionId:step.attempts.at(-1)?.actionId}));return this.get(agent,id);
  }
  revise(agent,id,{expectedVersion,priority,expectedValue,acceptance,appendMilestones=[]}={}){
    this.journal.assertAdmitted(agent);this.reconcile(agent,id);const row=this.raw(agent,id);this.version(row,expectedVersion);
    if(ended.has(row.status)||row.status==='completed')fail('GOAL_FINAL');if(!this.sourceValid(row))fail('GOAL_SOURCE_INVALID');
    if(row.support.revisionCount>=3)fail('GOAL_REVISION_LIMIT');
    if(!Array.isArray(appendMilestones)||appendMilestones.length>4||row.steps.length+appendMilestones.length>10)fail('INVALID_GOAL_MILESTONE');
    if(appendMilestones.length&&row.steps.some(s=>s.status==='failed'))fail('GOAL_RETRY_REQUIRED');
    if(appendMilestones.length&&row.steps.some(s=>['running','awaiting-approval'].includes(s.status)))fail('GOAL_PLAN_BUSY');
    const prior={priority:row.support.priority,expectedValue:row.support.expectedValue,acceptance:row.support.acceptance};
    const next=goalSupport({...row.support,...(priority===undefined?{}:{priority}),...(expectedValue===undefined?{}:{expectedValue}),...(acceptance===undefined?{}:{acceptance:goalAcceptance(acceptance)})},row.support.version===1);
    const additions=[];
    for(const m of appendMilestones){if(!m||!['research','learn-ai','write-report'].includes(m.kind)||Object.keys(m).some(k=>!['kind','question','sourceUrl','noteIds'].includes(k)))fail('INVALID_GOAL_MILESTONE');const question=clean(m.question,240);if(secret(question)||m.kind!=='learn-ai'&&m.sourceUrl!==undefined||m.kind!=='write-report'&&m.noteIds!==undefined)fail('INVALID_GOAL_MILESTONE');
      if(m.kind==='write-report'){if(m.noteIds!==undefined&&(!Array.isArray(m.noteIds)||!m.noteIds.length||m.noteIds.length>8||new Set(m.noteIds).size!==m.noteIds.length||!m.noteIds.every(n=>typeof n==='string'&&!!this.validNote(agent,n))))fail('INVALID_GOAL_REPORT_NOTES');if(m.noteIds===undefined&&![...row.steps,...additions].some(s=>['research','learn-ai'].includes(s.kind)))fail('GOAL_REPORT_REQUIRES_NOTES');}
      const step={id:randomUUID(),kind:m.kind,question,...(m.kind==='learn-ai'?{sourceUrl:researchUrl(m.sourceUrl)}:{}),...(m.kind==='write-report'?{actionId:null,...(m.noteIds?{noteIds:[...m.noteIds]}:{})}:{}),status:'pending',taskId:null,noteId:null,attempts:[]};
      if([...row.steps,...additions].some(s=>s.kind===step.kind&&s.question===step.question&&(s.sourceUrl??'')===(step.sourceUrl??'')&&sameIds(s.noteIds??[],step.noteIds??[])))fail('DUPLICATE_GOAL_MILESTONE');additions.push(step);
    }
    if(priority===undefined&&expectedValue===undefined&&acceptance===undefined&&!additions.length)fail('INVALID_GOAL');
    next.revisionCount++;next.revisions=[...next.revisions,{at:this.now(agent),version:row.version,prior,appendedStepIds:additions.map(s=>s.id)}].slice(-3);if(acceptance!==undefined||additions.length)next.review=null;
    row.support=next;row.steps.push(...additions);const status=row.status;if(additions.length){row.status='paused';row.reason='goal-plan-revised';row.evaluation=null;}else if(row.steps.every(s=>s.status==='completed')&&['needs-evidence','awaiting-review'].includes(status))this.evaluate(row);
    this.journal.transaction(()=>this.save(row,'goal-plan-revised',{revisionCount:next.revisionCount,appendedSteps:additions.length}));return this.get(agent,id);
  }
  review(agent,id,{expectedVersion,accepted,comment=''}={}){
    this.journal.assertAdmitted(agent);this.reconcile(agent,id);const row=this.raw(agent,id);this.version(row,expectedVersion);
    if(typeof accepted!=='boolean'||typeof comment!=='string'||comment.trim().length>500||secret(comment))fail('INVALID_GOAL_REVIEW');
    if(!['needs-evidence','awaiting-review'].includes(row.status)||!this.sourceValid(row)||!row.steps.every(s=>s.status==='completed'))fail('GOAL_NOT_REVIEWABLE');
    this.evaluate(row);if(accepted&&!row.evaluation.evidenceSatisfied)fail('GOAL_ACCEPTANCE_UNMET');if(!accepted&&!comment.trim())fail('INVALID_GOAL_REVIEW');
    row.support.acceptance={...row.support.acceptance,ownerReview:true};this.evaluate(row);row.support.review={accepted,comment:comment.trim(),at:this.now(agent),basis:row.evaluation.basis};this.evaluate(row);
    this.journal.transaction(()=>this.save(row,'goal-owner-reviewed',{accepted,comment:comment.trim(),unmet:row.evaluation.unmet}));return this.get(agent,id);
  }
  // Management reads do not mutate state. Runtime calls reconcile explicitly.
  get(agent,id){this.journal.assertAdmitted(agent);const r=this.raw(agent,id),sourceValid=this.sourceValid(r),evaluation=sourceValid&&!['blocked','cancelled','expired'].includes(r.status)?evaluateGoal(r,this.evidenceNotes(r),this.now(agent)):null;return {id:r.id,agent:r.agent,description:sourceValid?r.description:'[来源已失效]',refs:r.refs,status:r.status,version:r.version,expires:r.expires,created:r.created,updated:r.updated,reason:r.reason,retryAt:r.retry_at,sourceValid,originNote:r.origin_note,origin:r.support.origin,priority:r.support.priority,expectedValue:sourceValid?r.support.expectedValue:'',acceptance:sourceValid?r.support.acceptance:{...r.support.acceptance,requiredTerms:[],requiredQuestions:[]},revisionCount:r.support.revisionCount,revisionLimit:3,scheduling:r.support.schedule,steps:r.steps.map(s=>sourceValid?s:{...s,question:'[来源已失效]'}),progress:{completed:r.steps.filter(s=>s.status==='completed').length,total:r.steps.length},executionComplete:r.steps.every(s=>s.status==='completed'),achieved:r.status==='completed'&&evaluation?.achieved===true,evaluation};}
  list(agent,{status,limit=32}={}){this.journal.assertAdmitted(agent);if(status!==undefined&&!['proposed','active','paused','blocked','needs-evidence','awaiting-review','completed','cancelled','expired'].includes(status)||!Number.isInteger(limit)||limit<1||limit>128)fail('INVALID_GOAL_QUERY');return this.db.prepare('SELECT g.id FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id AND p.agent=g.agent WHERE g.agent=?'+(status?' AND g.status=?':'')+' ORDER BY p.created DESC,g.id LIMIT 128').all(agent,...(status?[status]:[])).map(r=>this.get(agent,r.id)).sort((a,b)=>b.priority-a.priority||b.created-a.created||a.id.localeCompare(b.id)).slice(0,limit);}
  context(agent,{limit=3,chars=1800}={}){if(!Number.isInteger(limit)||limit<1||limit>8||!Number.isInteger(chars)||chars<128||chars>4096)fail('INVALID_GOAL_QUERY');const output=[],rows=this.list(agent,{limit:128}).filter(r=>['active','blocked','needs-evidence','awaiting-review'].includes(r.status)&&r.sourceValid&&r.expires>this.now(agent)).sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1)||b.priority-a.priority||a.created-b.created);for(const r of rows){const step=r.steps.find(s=>s.status!=='completed'),item={id:r.id,description:r.description,status:r.status,priority:r.priority,expectedValue:r.expectedValue,progress:r.progress,executionComplete:r.executionComplete,achieved:r.achieved,unmet:r.evaluation?.unmet.slice(0,4).map(v=>v.label)??[],next:step?{stepId:step.id,kind:step.kind,question:step.question,status:step.status,...(step.actionId?{actionId:step.actionId}:{})}:null,reason:r.reason,retryAt:r.retryAt};if(output.length>=limit)break;if(JSON.stringify([...output,item]).length>chars)continue;output.push(item);}return output;}
  purge(agent){for(const row of this.db.prepare('SELECT goal FROM human_goal_plan WHERE agent=?').all(agent))this.journal.put(agent,'goalSupport:'+row.goal,null);this.db.prepare('DELETE FROM human_goal_plan WHERE agent=?').run(agent);}
}

