import {createAssistantMessage} from './api.mjs';
import {runToolTurn} from './tool-executor.mjs';

const statuses=new Set(['proposed','completed','blocked','expired']);
const noticeKey=r=>'action-notice:'+r.id+':'+r.status;
const allowed=agent=>!agent.factory.journal.value(agent.id,'autonomyPaused',false)&&!agent.factory.journal.value(agent.id,'autonomyError',null);
function pendingNotice(agent){
  const {actions,journal:j,goals}=agent.factory;if(!actions)return null;
  const sent=new Set(agent.session.snapshotEvents().filter(e=>e.type==='assistant/message').map(e=>e.data.message.id));
  for(const row of actions.list(agent.id)){
    const capabilityOwner=j.value(agent.id,'capabilityOwnedAction:'+row.id,null);
    if(capabilityOwner&&j.db.prepare('SELECT status FROM human_tool_job WHERE agent=? AND id=?').get(agent.id,capabilityOwner.jobId)?.status!=='completed')continue;
    if(j.value(agent.id,'action-loop-error:'+row.id,null)||!statuses.has(row.status)||!row.sourceValid||row.status==='proposed'&&(!row.goal||!goals.actionAllowed(agent.id,row)))continue;
    const notice=j.value(agent.id,noticeKey(row),null);if(!notice||!sent.has(notice.messageId))return {row,notice};
  }return null;
}
export function nextActionWork(agent){
  if(!agent.factory.actions||!allowed(agent))return null;
  const toolJob=agent.factory.tools?.next(agent.id);if(toolJob)return {toolJob};
  const j=agent.factory.journal,excludeIds=j.db.prepare("SELECT key FROM metadata WHERE agent=? AND key LIKE 'action-loop-error:%' AND value<>'null'").all(agent.id).map(r=>r.key.slice('action-loop-error:'.length));
  const action=agent.factory.actions.next(agent.id,{excludeIds});return action?{execute:action}:pendingNotice(agent);
}
function noticeText(row){
  if(row.status==='proposed')return `《${row.title}》的草稿准备好了，Web 的“任务 → 报告与文件”里可以查看。你确认后，我再保存。`;
  if(row.status==='completed')return `《${row.title}》已经保存好了，内容也核对过了。需要时可以在 Web 的“任务 → 报告与文件”里打开。`;
  return `《${row.title}》${row.status==='expired'?'的保存授权到期了':'的保存需要你看一下'}，这次没有继续写入。Web 的“任务 → 报告与文件”里有具体状态。`;
}
// This is one serial driver turn. It uses no model and never expands a grant.
export async function runActionTurn(agent,signal,work){
  if(work.toolJob)return runToolTurn(agent,signal,work.toolJob);
  const f=agent.factory,j=f.journal,id=agent.id,epoch=agent.desired().epoch,remaining=j.value(id,'remaining',0);
  if(remaining!==null&&remaining<=0){j.set(id,'paused');return;}
  const turn=(agent.ctx.sessionProjections.stateOf(agent.session,'turnBoundary')?.lastTurn??0)+1;
  const valid=()=>{signal.throwIfAborted();j.assertAdmitted(id);if(agent.desired().desired!=='running'||agent.desired().epoch!==epoch||!allowed(agent))throw new Error('STALE_RESULT');};
  let stageId,row=work.execute??work.row,reason={kind:'completed'};agent.activeLane='action';
  agent.session.append('turn/start',{turn});agent.session.append('step/start',{turn,step:1});
  try{
    valid();
    if(work.execute){row=await f.actions.execute(id,row.id,{signal,valid});f.goals.reconcile(id);valid();}
    // A completion may be a recovered, previously unannounced result. Check
    // the real file again before claiming success in the canonical Session.
    if(row.status==='completed'){f.actions.verifyReceipt(id,row.id);f.goals.reconcile(id);row=f.actions.get(id,row.id);valid();}
    if(!statuses.has(row.status)||!row.sourceValid)return;
    const key=noticeKey(row),notice=j.value(id,key,null)??{messageId:crypto.randomUUID(),actionId:row.id,status:row.status};j.put(id,key,notice);
    if(agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===notice.messageId))return;
    const text=noticeText(row),data={turn,step:1,message:{...createAssistantMessage({content:[{type:'text',text}],source:{provider:'local-action',model:row.status==='completed'?'file-receipt':'action-status'}}),id:notice.messageId},stream:[]};
    valid();stageId=crypto.randomUUID();j.stageResponse(id,stageId,turn,epoch,'MESSAGE',{data,textChars:text.length,reasoningChars:0});
    valid();agent.session.append('assistant/message',data,{surfaceOp:'append'});await agent.flush();j.reconcile(agent.session);j.commitResponse(stageId);
    j.audit(id,'action-notified',{actionId:row.id,title:row.title,status:row.status,messageId:notice.messageId,origin:'owner',lane:'action'});
  }catch(error){
    if(signal.aborted||error.message==='STALE_RESULT')reason={kind:'aborted',reason:{kind:'user'}};
    else {reason={kind:'error',error:{code:'ACTION_EXECUTION_FAILED',message:'ACTION_EXECUTION_FAILED'}};const code=/^[A-Z_]{3,64}$/.test(error.message)?error.message:'ACTION_EXECUTION_FAILED';j.put(id,'actionLoopError',{actionId:row?.id,code});if(row?.id)j.put(id,'action-loop-error:'+row.id,{code});j.audit(id,'action-turn-failed',{actionId:row?.id,code,lane:'action'});}
  }finally{
    if(stageId){const staged=j.db.prepare('SELECT state,payload FROM response_stage WHERE id=?').get(stageId);if(staged?.state==='ready'){const payload=JSON.parse(staged.payload),exists=agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===payload.data.message.id);if(exists){await agent.flush();j.reconcile(agent.session);j.commitResponse(stageId);}else j.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(stageId);}}
    agent.session.append('step/end',{turn,step:1});agent.session.append('turn/end',{turn,reason});await agent.flush();j.reconcile(agent.session);
    if(remaining!==null){j.put(id,'remaining',Math.max(0,remaining-1));if(remaining<=1&&agent.desired().desired==='running'){j.set(id,'paused');j.put(id,'stopReason','cycle-limit');clearTimeout(agent.timer);agent.timer=undefined;}}
    agent.activeLane=undefined;if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length||nextActionWork(agent))agent.wake=true;
  }
}
