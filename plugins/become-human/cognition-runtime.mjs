import {randomUUID} from 'node:crypto';

const clip=(value,max=180)=>Array.from(String(value??'')).slice(0,max).join('');
const liveAgent=(factory,id)=>[...factory.handles].map(handle=>handle.agent).find(agent=>agent?.id===id);
const runtimeOf=(factory,id)=>{const agent=liveAgent(factory,id);return {running:!!agent?.active,activeLane:agent?.activeLane??null};};
export const boardOperations=new Set(['board-item-create','board-item-update','board-item-transition','board-focus-set','board-focus-clear','board-reflection-apply','board-reflection-dismiss']);

// The UI is a view of the same Session-scoped records used by the driver.
// It does not create an agent, a model runner or another conversation.
export function characterBoard(factory,id,{limit=50}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('INVALID_MATTER_QUERY');
  const store=factory.cognition,snapshot=store.snapshot(id,{runtime:runtimeOf(factory,id)});
  const loaded=[];let total=0;
  for(let offset=0;offset<limit;offset+=100){const page=store.listMatters(id,{limit:Math.min(100,limit-offset),offset});loaded.push(...page.items);total=page.total;if(!page.hasMore)break;}
  const normalize=item=>({...item,sourceDetails:item.source,source:item.origin});
  const items=loaded.map(normalize);
  const itemForTask=taskId=>{const item=items.find(item=>item.refs.some(ref=>ref.type==='task'&&ref.id===taskId))??store.matterForTask(id,taskId);if(item&&!items.some(row=>row.id===item.id))items.push(normalize(item));return item;};
  if(snapshot.attention.matterId&&!items.some(item=>item.id===snapshot.attention.matterId))try{items.push(normalize(store.getMatter(id,snapshot.attention.matterId)));}catch{}
  const reflections=snapshot.reflections.map(record=>{
    const item=itemForTask(record.evidence?.task?.id),review=record.review;
    const status=record.evidence?.task?.status??'unknown',result={completed:'任务执行结束；价值与满意度仍待反馈',failed:'任务未完成，失败记录已保留',cancelled:'任务已取消，本次没有继续执行'}[status]??'结果待核对';
    return {...record,version:item?.version??0,itemId:item?.id??null,taskId:record.evidence?.task?.id??null,at:record.created,outcome:status,result,expectedOutcome:record.comparison?.expected??null,evidenceDetails:record.evidence,
      evidence:[...(record.evidence?.reason?[{type:'diagnostic',text:'结果原因：'+record.evidence.reason}]:[]),{type:'task',id:record.evidence?.task?.id,text:'任务状态：'+(record.evidence?.task?.status??'unknown')},...(record.evidence?.notes??[]).map(note=>({type:'note',id:note.id,text:note.sourceValid?'有效学习笔记':'笔记依据待核对'})),...(record.evidence?.published??[]).map(row=>({id:String(row.auditSeq),text:'本地发布回执；手机实收需另行核对'}))],
      nextStep:record.recommendation?.reason??'',summary:record.recommendation?.reason??'',
      suggestion:{...record.suggestion,summary:record.suggestion?.nextAction??record.recommendation?.reason,status:review?.status??(item&&!['completed','dropped'].includes(item.status)?'pending':'unavailable')},status:review?.status??'pending'};
  });
  const decisionLabels={focus:'开始关注','manual-focus':'主人指定关注','manual-release':'主人清除关注',release:'释放关注',wait:'等待',yield:'让出执行'};
  const decisions=snapshot.decisions.map(row=>({...row,at:row.created,itemId:row.matterId??null,summary:row.reason??row.decision,basis:row.basis??[],outcome:decisionLabels[row.decision]??row.decision}));
  const status=snapshot.self.status;
  return {...snapshot,items,matters:{total,limit,offset:0,hasMore:limit<total,items:undefined},decisions,reflections,self:{...snapshot.self,
    identity:{...snapshot.self.identity,interests:snapshot.self.identity?.configuredInterests,responsibilities:snapshot.self.identity?.configuredGoals},
    status:{...status,label:status.error?'自主异常':status.paused?'自主已暂停':status.running?'正在处理':status.desired==='running'?'等待下一事件':'已暂停',summary:status.error??status.waitReason??'按当前配置和实际运行记录更新',autonomyPaused:status.paused},
    capabilities:snapshot.self.capabilities.map(cap=>({...cap,name:cap.title??cap.id,state:cap.available?'available':'unavailable',reason:cap.unavailableReason??(cap.effect==='write'?'写操作仍需逐次批准':'仅按已配置范围使用')})),
    uncertainties:snapshot.self.uncertainties.map((value,index)=>({id:'unknown-'+index,text:typeof value==='string'?value:value.text,refs:[]}))},
    attention:{...snapshot.attention,basis:[{text:snapshot.attention.method},{text:'执行门禁：'+(snapshot.attention.gates?.reasons?.join('、')||'当前没有已记录阻塞')}],nextReviewAt:snapshot.attention.candidates?.[0]?.nextEligibleAt??null}};
}

export function compactCognition(agent,{limit=3}={}){
  const store=agent.factory.cognition;if(!store)return null;
  const self=store.selfModel(agent.id,{runtime:{running:!!agent.active,activeLane:agent.activeLane??null}}),focus=store.attentionState(agent.id);
  const items=store.contextMatters(agent.id,{limit});
  const focusValid=!focus.matterId||(()=>{try{return store.getMatter(agent.id,focus.matterId).refs.every(ref=>ref.valid);}catch{return false;}})();
  return {version:1,revision:store.revision(agent.id),status:{desired:self.status.desired,phase:self.status.phase,autonomyPaused:self.status.paused,activeLane:self.status.activeLane},
    attention:{matterId:focus.matterId,taskId:focus.taskId,reason:focusValid?clip(focus.reason):'关联依据已失效，需先核对'},
    matters:items.map(item=>({id:item.id,version:item.version,title:clip(item.title,100),kind:item.kind,status:item.status,priority:item.priority,why:clip(item.why,120),nextAction:clip(item.nextAction,140),stopCondition:clip(item.stopCondition,140),sourceKind:item.sourceKind,refs:item.refs.slice(0,4).map(ref=>({type:ref.type,id:ref.id,valid:ref.valid}))})),
    reflections:store.reflections(agent.id,{limit:2}).items.map(record=>({id:record.id,taskId:record.evidence.task.id,result:record.evidence.task.status,reason:record.evidence.reason,nextStep:record.evidenceValidityChanged?'关联依据已变化，需先核对，不沿用旧结论。':clip(record.recommendation.reason,180),requiresReevaluation:record.evidenceValidityChanged===true,reviewStatus:record.review?.status??'unreviewed'})),
    capabilities:self.capabilities.filter(cap=>cap.available).slice(0,6).map(cap=>({id:cap.id,effect:cap.effect,autonomous:cap.autonomous})),
    limits:{singleMainSession:true,singleExecutionLane:true,taskReceiptIsNotOwnerSatisfaction:true,changesRequireExistingPermissions:true},scope:'Configured identity remains persona. This block contains intentions, runtime facts and labelled inferences, not owner facts or proof of consciousness.'};
}

export function matterAllowed(agent,task){
  const matterId=task?.checkpoint?.matterId;if(!matterId||!agent.factory.cognition)return true;
  try{const item=agent.factory.cognition.getMatter(agent.id,matterId);return item.status==='watching'&&item.attentionReady&&(task.checkpoint.matterVersion===undefined||item.version===task.checkpoint.matterVersion);}
  catch{return false;}
}

// Matters propose directions within the existing scheduler. They cannot turn
// a conversation into an unrestricted tool job or auto-activate a goal.
export function boardCandidate(agent,settings,{chat=null,now=Date.now()}={}){
  const store=agent.factory.cognition;if(!store)return null;
  const selection=store.attentionCandidates(agent.id,{now,candidateLimit:128});
  if(!selection.gates.allowed)return null;
  const focus=store.attentionState(agent.id),preferred=focus.preferredMatterId??focus.matterId;
  const ordered=[...selection.candidates].sort((a,b)=>(b.matterId===preferred)-(a.matterId===preferred)||b.score-a.score);
  for(const row of ordered){
    const item=store.getMatter(agent.id,row.matterId);
    if(item.request_id?.startsWith('autonomy-task:'))continue;
    const linked=[...item.refs.filter(ref=>ref.type==='task').map(ref=>agent.factory.autonomy.getTask(ref.id)).filter(Boolean),...agent.factory.journal.db.prepare("SELECT id,status FROM autonomy_task WHERE agent=? AND json_extract(checkpoint,'$.matterId')=?").all(agent.id,item.id)];
    // A user reopening a matter is not authorisation to retry its failed task.
    if(linked.some(task=>['failed','ready','suspended','waiting-budget','executing'].includes(task.status)))continue;
    const question=clip(item.nextAction||item.title,240);
    if(['research','question'].includes(item.kind)&&settings.learningEnabled&&settings.searchEnabled){
      const candidate={kind:'research',question,matterId:item.id,matterVersion:item.version,matterContract:{title:clip(item.title,100),why:clip(item.why,180),expectedOutcome:clip(item.expectedOutcome,200),stopCondition:clip(item.stopCondition,200)}};
      if(!agent.factory.autonomy.deferred(agent.id,{candidate,matterId:item.id},now))return candidate;
    }
    if(item.kind==='conversation'&&chat)return {...chat,matterId:item.id,matterVersion:item.version,matterContract:{title:clip(item.title,100),why:clip(item.why,180),expectedOutcome:clip(item.expectedOutcome,200),stopCondition:clip(item.stopCondition,200)},question:clip(chat.question+'；结合当前关注事项：'+question,240)};
  }
  return null;
}

export function linkMatterTask(agent,task){
  const store=agent.factory.cognition;if(!store)return task;
  let item;
  try{item=store.bindTask(agent.id,task,{question:task.checkpoint.plan?.question,value:task.checkpoint.plan?.value});}
  catch(error){if(task.checkpoint.matterId||error.message!=='MATTER_LIMIT')throw error;agent.factory.journal.audit(agent.id,'matter-binding-held',{taskId:task.id,code:'MATTER_LIMIT'});return task;}
  const checkpoint={...task.checkpoint,matterId:item.id,matterVersion:item.version,...(item.request_id?.startsWith('autonomy-task:')&&task.checkpoint.plan?.question?{candidate:{...task.checkpoint.candidate,question:task.checkpoint.plan.question}}:{})};
  agent.factory.autonomy.update(task.id,task.status,checkpoint);
  return agent.factory.autonomy.getTask(task.id);
}

export function bindMatterTask(agent,task){
  const store=agent.factory.cognition;if(!store)return task;
  task=linkMatterTask(agent,task);if(!task.checkpoint.matterId)return task;
  const item=store.getMatter(agent.id,task.checkpoint.matterId);
  const current=store.attentionState(agent.id);
  try{store.focus(agent.id,{requestId:'task-focus:'+task.id+':'+current.version,matterId:item.id,taskId:task.id,expectedVersion:current.version,budgetAllowed:true,ownerPending:false,reason:clip(task.checkpoint.plan?.value||'按已通过预检的单次任务计划执行',500)});}
  catch(error){agent.factory.journal.audit(agent.id,'attention-focus-held',{taskId:task.id,matterId:item.id,code:/^[A-Z_]+$/.test(error.message)?error.message:'ATTENTION_HELD'});}
  return agent.factory.autonomy.getTask(task.id);
}

export function reconcileCognition(agent,task){
  const store=agent.factory.cognition;if(!store)return;
  if(task&&['completed','failed','cancelled'].includes(agent.factory.autonomy.getTask(task.id)?.status))store.reflectTask(agent.id,task.id);
  store.reconcile(agent.id,{limit:4});
  const focus=store.attentionState(agent.id);
  if(focus.taskId&&(focus.taskId===task?.id||agent.activeLane==='foreground'))store.clearFocus(agent.id,'segment-released');
}

// This hook is called only after the existing explicit task retry validation.
// A board edit alone never calls it or clears a failed task's backoff.
export function prepareMatterRetry(agent,task){
  const store=agent.factory.cognition;if(!store||!task.checkpoint.matterId)return task.checkpoint;
  let item=store.getMatter(agent.id,task.checkpoint.matterId);
  if(item.origin==='agent'&&item.request_id==='autonomy-task:'+task.id&&['blocked','paused'].includes(item.status))item=store.transitionMatter(agent.id,item.id,'watch',{requestId:'retry-matter:'+randomUUID(),expectedVersion:item.version,reason:'主人已在原任务入口明确授权本任务重试'},{actor:'system'});
  if(item.status!=='watching'||!item.attentionReady)throw new Error('MATTER_NOT_ATTENTION_READY');
  return {...task.checkpoint,matterVersion:item.version};
}

export function controlBoard(agent,input){
  const {cognition:store}=agent.factory,id=agent.id,{op,sessionId,...fields}=input;
  const requestId=fields.requestId??randomUUID();
  let result;
  if(op==='board-item-create'){const {id:unused,...data}=fields;result=store.createMatter(id,{...data,requestId},{actor:'owner'});}
  else if(op==='board-item-update'){const {id:matterId,...data}=fields;result=store.reviseMatter(id,matterId,{...data,requestId},{actor:'owner'});}
  else if(op==='board-item-transition'){const {id:matterId,action,...data}=fields;result=store.transitionMatter(id,matterId,action,{...data,reason:data.reason||action,requestId},{actor:'owner'});}
  else if(op==='board-focus-set'){
    const item=store.getMatter(id,fields.id);result=store.manualFocus(id,{requestId,matterId:item.id,expectedVersion:fields.expectedVersion,reason:'主人在人物看板设置的当前关注'});
  }else if(op==='board-focus-clear')result=store.manualRelease(id,{requestId,expectedVersion:fields.expectedVersion,reason:'主人清除当前关注'});
  else if(op==='board-reflection-apply'||op==='board-reflection-dismiss'){
    const reflection=store.getReflection(id,fields.id);
    const item=reflection.review?.matterId?store.getMatter(id,reflection.review.matterId):store.matterForTask(id,reflection.evidence.task.id);if(!item)throw new Error('REFLECTION_MATTER_MISMATCH');
    result=store.applyReflectionSuggestion(id,reflection.id,{requestId,matterId:item.id,expectedVersion:fields.expectedVersion,expectedReviewVersion:reflection.review?.version??0,action:op==='board-reflection-apply'?'apply':'dismiss'},{actor:'owner'});
  }else throw new Error('UNKNOWN_OPERATION');
  // Changing a matter invalidates only its background segment, never the
  // owner's foreground turn, the driver setting, the Session or IM pairing.
  if(agent.active&&agent.activeLane!=='foreground'&&agent.activeCognitionTask&&!matterAllowed(agent,agent.activeCognitionTask)){
    agent.factory.journal.set(id,agent.desired().desired);agent.cause={kind:'board-updated'};agent.cancelController?.abort();
  }
  return result;
}
