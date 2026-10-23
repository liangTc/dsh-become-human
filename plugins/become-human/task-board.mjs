// A read-only projection of retained records in the canonical Session. This is
// not a scheduler, a new task store or a second conversation.
const sources=['autonomy','goal','tool','action','schedule'];
const groups=['pending','running','attention','done'];
const parse=(value,fallback=null)=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};
const clean=(value,max=240)=>String(value??'').replace(/([?&](?:token|api[_-]?key|access[_-]?token|password|secret|authorization|signature)=)[^\s&#]+/giu,'$1[隐藏]').replace(/(?:Bearer\s+\S+|sk-[\w-]{16,})/giu,'[隐藏]').replace(/((?:api.?key|password|密码|令牌|token)\s*[:=]\s*)\S{8,}/giu,'$1[隐藏]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,'').slice(0,max);
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const ref=(source,id)=>id?{source,id:source+':'+id,recordId:String(id)}:null;
const labels={ready:'待执行',pending:'待触发',queued:'待执行',suspended:'已保存进度',paused:'已暂停','waiting-budget':'等待额度',executing:'执行中',running:'执行中',staged:'正在提交',failed:'执行失败',unknown:'结果未知',blocked:'需要处理',proposed:'等待确认',approved:'已批准','awaiting-approval':'等待批准',active:'推进中','needs-evidence':'需要补充证据','awaiting-review':'等待验收',completed:'执行完成',committed:'已写入会话',cancelled:'已取消',expired:'已到期',archived:'记录已归档'};
const kindLabels={research:'自主研究','learn-ai':'阅读学习',chat:'主动闲聊',care:'主动关心','share-insight':'主动分享','write-report':'文件报告'};
function groupOf(source,status){
  if(['executing','running','staged'].includes(status))return 'running';
  if(['failed','unknown','blocked','needs-evidence','awaiting-review','awaiting-approval'].includes(status)||source==='action'&&['proposed','expired'].includes(status))return 'attention';
  if(['completed','committed','cancelled','expired'].includes(status))return 'done';
  return 'pending';
}
function card(source,row,extra={}){
  const statusLabel=row.status==='pending'?(source==='schedule'?'待触发':'待执行'):source==='autonomy'&&row.status==='cancelled'?'本轮已终止':labels[row.status]??clean(row.status,60);
  return {id:source+':'+row.id,source,recordId:row.id,title:clean(row.title||kindLabels[row.kind]||row.id,240),status:row.status,statusLabel,group:groupOf(source,row.status),kind:row.kind??source,created:number(row.created),updated:number(row.updated??row.created),summary:'',reason:null,progress:null,children:[],links:[],origin:'unknown',result:null,usage:null,attempts:[],...extra};
}
function inputQuery(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('INVALID_TASK_BOARD_QUERY');
  const {source='all',group='all',query='',limit=40,offset=0,from,to,recordId}=input;
  if(!['all',...sources].includes(source)||!['all',...groups].includes(group)||typeof query!=='string'||query.length>160||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000||from!==undefined&&(!Number.isSafeInteger(from)||from<0)||to!==undefined&&(!Number.isSafeInteger(to)||to<0)||from!==undefined&&to!==undefined&&to<from||recordId!==undefined&&(typeof recordId!=='string'||!recordId.length||recordId.length>128||/[\u0000-\u001f]/u.test(recordId)))throw new Error('INVALID_TASK_BOARD_QUERY');
  return {source,group,query:query.trim().toLocaleLowerCase(),limit,offset,from,to,recordId};
}
function usageOf(attempts){
  if(!attempts.length)return null;
  return {requests:attempts.length,reportedTokens:attempts.reduce((sum,row)=>sum+(row.usageConfidence==='reported'?number(row.usage?.totalTokens):0),0),unknownUsageRequests:attempts.filter(row=>row.usageConfidence!=='reported'||!row.usage).length,conservativeAdmission:attempts.reduce((sum,row)=>sum+number(row.reserved),0),meaning:'供应商报告 token 与保守准入量分别累计；执行尝试不是子 Agent。'};
}
function attemptView(row){
  const usage=parse(row.usage),safeUsage=usage&&typeof usage==='object'?Object.fromEntries(['totalTokens','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].filter(key=>Number.isSafeInteger(usage[key])&&usage[key]>=0).map(key=>[key,usage[key]])):null;
  return {id:'attempt:'+row.id,recordId:row.id,kind:'execution-attempt',label:'执行尝试',status:row.state,statusLabel:labels[row.state]??clean(row.state,60),started:number(row.started),ended:row.ended==null?null:number(row.ended),reason:row.error?clean(row.error):null,usage:safeUsage,usageConfidence:clean(row.usage_confidence,40),reserved:number(row.reserved)};
}
function stepAttempt(value,index,goalId,stepId){
  return {id:'goal-attempt:'+goalId+':'+stepId+':'+index,kind:'execution-attempt',label:'执行尝试',status:clean(value?.status,60),statusLabel:labels[value?.status]??clean(value?.status,60),taskId:typeof value?.taskId==='string'?value.taskId:null,actionId:typeof value?.actionId==='string'?value.actionId:null,noteId:typeof value?.noteId==='string'?value.noteId:null,started:number(value?.started),ended:value?.ended==null?null:number(value.ended),reason:value?.reason?clean(value.reason):null};
}

export function taskBoard(factory,sessionId,input={}){
  const q=inputQuery(input),journal=factory.journal,db=journal.db;journal.assertAdmitted(sessionId);
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)),warnings=[];
  const available=(source,...names)=>{const missing=names.filter(name=>!tables.has(name));if(missing.length)warnings.push({source,code:'TABLE_UNAVAILABLE',tables:missing});return !missing.length;};
  const taskRows=available('autonomy','autonomy_task')?db.prepare('SELECT id,kind,status,checkpoint,created,updated FROM autonomy_task WHERE agent=?').all(sessionId):[];
  const goalRows=available('goal','goal_record','human_goal_plan')?db.prepare('SELECT g.id,g.description,g.status,g.version,g.expires,p.steps,p.created,p.updated,p.reason,p.retry_at,p.evaluation FROM goal_record g JOIN human_goal_plan p ON p.agent=g.agent AND p.goal=g.id WHERE g.agent=?').all(sessionId):[];
  const attempts=new Map();
  if(tables.has('attempt')){
    const reserved=tables.has('reservation')?'(SELECT amount FROM reservation r WHERE r.id=a.id AND r.agent=a.agent)':'NULL';
    for(const row of db.prepare(`SELECT id,state,usage,usage_confidence,error,started,ended,CASE WHEN json_valid(request) THEN json_extract(request,'$.taskId') END AS taskId,${reserved} AS reserved FROM attempt a WHERE agent=?`).all(sessionId))if(typeof row.taskId==='string'){const list=attempts.get(row.taskId)??[];list.push(attemptView(row));attempts.set(row.taskId,list);}
    for(const list of attempts.values())list.sort((a,b)=>a.started-b.started||a.id.localeCompare(b.id));
  }
  const tasks=new Map(),goalTasks=new Set(),all=[];
  for(const row of taskRows){
    const cp=parse(row.checkpoint,{})??{},goalId=typeof cp.goal?.id==='string'?cp.goal.id:null,matterId=typeof cp.matterId==='string'?cp.matterId:null;
    const executionAttempts=attempts.get(row.id)??[];
    tasks.set(row.id,card('autonomy',{...row,title:cp.plan?.question||cp.candidate?.question||kindLabels[row.kind]},
      {taskId:row.id,goalId,matterId,origin:'autonomous',summary:clean(cp.plan?.value||kindLabels[row.kind]||'按本轮已记录方向执行'),reason:row.status!=='completed'&&cp.reason?clean(cp.reason):null,attempts:executionAttempts,usage:usageOf(executionAttempts),links:[ref('goal',goalId),matterId?{source:'matter',id:'matter:'+matterId,recordId:matterId}:null].filter(Boolean),result:{noteId:typeof cp.noteId==='string'?cp.noteId:null,sourceReadCount:number(cp.researchReads),meaning:row.status==='completed'?'任务执行结束；不代表主人满意或手机已实收。':row.status==='cancelled'?'本次方向已结束，不代表产生了有效成果。':'结果以实际执行记录为准。'}}));
  }
  const goals=new Map();
  for(const row of goalRows){
    const steps=parse(row.steps,[]),validSteps=Array.isArray(steps)?steps.filter(step=>step&&typeof step==='object'&&!Array.isArray(step)&&typeof step.id==='string'&&typeof step.kind==='string'&&typeof step.status==='string'):[];
    const children=validSteps.map(step=>{
      if(step.taskId)goalTasks.add(step.taskId);for(const attempt of Array.isArray(step.attempts)?step.attempts:[])if(attempt?.taskId)goalTasks.add(attempt.taskId);
      const task=typeof step.taskId==='string'?tasks.get(step.taskId)??{id:'autonomy:'+step.taskId,source:'autonomy',recordId:step.taskId,taskId:step.taskId,title:'执行任务已归档或不可用',status:'archived',statusLabel:'记录已归档',archived:true,group:['completed','cancelled','expired'].includes(step.status)?'done':'attention',summary:'保留了原步骤关联，未重建历史执行内容。',children:[],attempts:attempts.get(step.taskId)??[],usage:usageOf(attempts.get(step.taskId)??[])}:null;
      return {id:'goal-step:'+row.id+':'+step.id,source:'goal-step',recordId:step.id,goalId:row.id,taskId:step.taskId??null,actionId:step.actionId??null,title:clean(step.question||kindLabels[step.kind]||'目标步骤'),kind:step.kind,status:step.status,statusLabel:step.status==='pending'?'尚未开始':labels[step.status]??clean(step.status,60),group:task?.group??groupOf('goal',step.status),summary:kindLabels[step.kind]??clean(step.kind),reason:step.error?clean(step.error):null,progress:null,children:[],task,attempts:(Array.isArray(step.attempts)?step.attempts:[]).map((attempt,index)=>stepAttempt(attempt,index,row.id,step.id)),links:[ref('autonomy',step.taskId),ref('action',step.actionId)].filter(Boolean),result:{noteId:step.noteId??null,completedAt:step.completedAt??null,receipt:step.receipt?{digest:clean(step.receipt.sha256??step.receipt.digest,64),bytes:number(step.receipt.bytes),path:clean(step.receipt.path,512),meaning:'已保存的文件回执；本次读取未重新校验磁盘内容。'}:null}};
    });
    const modelAttempts=[...new Map(validSteps.flatMap(step=>[step.taskId,...(Array.isArray(step.attempts)?step.attempts.map(attempt=>attempt?.taskId):[])].filter(value=>typeof value==='string').flatMap(taskId=>attempts.get(taskId)??[])).map(attempt=>[attempt.id,attempt])).values()];
    const evaluation=parse(row.evaluation),item=card('goal',{...row,title:row.description,kind:'goal'},{goalId:row.id,origin:'recorded-goal',children,usage:usageOf(modelAttempts),summary:'按真实步骤推进；执行完成和目标验收分别展示。',reason:row.reason?clean(row.reason):null,progress:{completed:validSteps.filter(step=>step.status==='completed').length,total:validSteps.length},result:{executionComplete:validSteps.length>0&&validSteps.every(step=>step.status==='completed'),achieved:row.status==='completed'&&evaluation?.achieved===true,unmet:Array.isArray(evaluation?.unmet)?evaluation.unmet.slice(0,12).map(value=>({label:clean(value?.label??value,160)})):[],meaning:'仅按保存的状态与验收依据展示，不在读取时推进目标。'}});
    if(row.status==='active'&&children.some(child=>child.group==='attention'))item.group='attention';
    else if(row.status==='active'&&children.some(child=>child.group==='running'))item.group='running';
    goals.set(row.id,item);all.push(item);
  }
  // Checkpoint links also preserve deduplication for older plans that omitted a
  // step taskId. Attach only to the actual persisted matching step.
  for(const row of taskRows){const cp=parse(row.checkpoint,{})??{},goal=goals.get(cp.goal?.id);if(!goal)continue;const step=goal.children.find(child=>child.recordId===cp.goal?.stepId);if(step){goalTasks.add(row.id);if(!step.task){step.task=tasks.get(row.id);step.taskId=row.id;step.links.push(ref('autonomy',row.id));}}}
  for(const task of tasks.values())if(!goalTasks.has(task.recordId))all.push(task);
  if(available('tool','human_tool_job')){
    const meta=tables.has('human_capability_job'),join=meta?' LEFT JOIN human_capability_job c ON c.agent=j.agent AND c.id=j.id':'',fields=meta?",c.origin,c.task_id,CASE WHEN json_valid(c.snapshot) THEN json_extract(c.snapshot,'$.effect') END effect,CASE WHEN json_valid(c.snapshot) THEN json_extract(c.snapshot,'$.title') END toolTitle":",NULL origin,NULL task_id,NULL effect,NULL toolTitle";
    for(const row of db.prepare('SELECT j.id,j.tool,j.status,j.created,j.updated,j.error,j.result'+fields+' FROM human_tool_job j'+join+' WHERE j.agent=?').all(sessionId)){
      const result=parse(row.result),linked=typeof result?.actionId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result.actionId)?result.actionId:null;
      all.push(card('tool',{...row,title:row.toolTitle||row.tool,kind:row.tool},{jobId:row.id,taskId:row.task_id??null,actionId:linked,origin:row.origin??'unknown',summary:row.effect==='write'?'写操作按原审批流程执行。':'已登记工具作业；工具完成不等于结论已核验。',reason:row.error?clean(row.error):null,links:[ref('autonomy',row.task_id),ref('action',linked)].filter(Boolean),result:{effect:row.effect??'unknown',status:typeof result?.status==='string'?clean(result.status,60):null,truncated:result?.truncated===true,meaning:row.status==='unknown'?'操作结果未知，不自动重试。':'只展示作业和结果摘要，不返回工具输入或原始输出。'}}));
    }
  }
  if(available('action','human_action'))for(const row of db.prepare('SELECT id,kind,title,status,goal,note_ids,digest,bytes,path,receipt,reason,created,updated FROM human_action WHERE agent=?').all(sessionId)){
    const goal=parse(row.goal),receipt=parse(row.receipt),noteIds=parse(row.note_ids,[]);
    all.push(card('action',row,{actionId:row.id,goalId:goal?.id??null,origin:'recorded-action',summary:row.status==='completed'?'已保存文件行动回执。':'文件行动沿用现有逐次批准规则。',reason:row.reason?clean(row.reason):null,links:[ref('goal',goal?.id)].filter(Boolean),result:{path:clean(row.path,512),digest:clean(row.digest,64),bytes:number(row.bytes),noteIds:Array.isArray(noteIds)?noteIds.filter(value=>typeof value==='string').slice(0,8):[],receipt:receipt?{path:clean(receipt.path,512),digest:clean(receipt.sha256??receipt.digest,64),bytes:number(receipt.bytes),completedAt:number(receipt.completedAt)}:null,meaning:'文件路径和哈希来自已保存记录；本次读取不访问文件或重新确认完整性。'}}));
  }
  if(available('schedule','reminder'))for(const row of db.prepare('SELECT id,title,text,rule,mode,status,error,due_at,created,updated,source,committed_at FROM reminder WHERE agent=?').all(sessionId)){
    const rule=parse(row.rule),history=tables.has('reminder_delivery')?db.prepare('SELECT occurrence,committed FROM reminder_delivery WHERE agent=? AND reminder=? ORDER BY committed DESC LIMIT 1').get(sessionId,row.id):null,count=tables.has('reminder_delivery')?db.prepare('SELECT count(*) n FROM reminder_delivery WHERE agent=? AND reminder=?').get(sessionId,row.id).n:0;
    const executionAttempts=attempts.get('schedule:'+row.id)??[];
    all.push(card('schedule',{...row,title:row.title||rule?.title||row.text,kind:rule?.kind??'at'},{scheduleId:row.id,origin:clean(row.source,60),summary:row.mode==='prompt'?'到点按配置执行一次提示任务。':'到点在唯一会话发出提醒。',reason:row.error?clean(row.error):null,attempts:executionAttempts,usage:usageOf(executionAttempts),result:{mode:row.mode??'notify',ruleKind:rule?.kind??'at',nextAt:number(row.due_at),timeZone:typeof rule?.timeZone==='string'?clean(rule.timeZone,100):null,deliveryCount:number(count),lastCommittedAt:history?.committed??row.committed_at??null,lastOccurrenceAt:history?.occurrence??null,meaning:'投递次数表示结果已写入唯一会话，不能据此认定手机实收。'}}));
  }
  const counts={all:all.length,pending:0,running:0,attention:0,done:0},sourceCounts=Object.fromEntries(sources.map(source=>[source,0]));
  for(const item of all){counts[item.group]++;sourceCounts[item.source]++;}
  const queryMatches=item=>!q.query||[item.title,item.summary,item.reason,item.recordId,item.kind,...item.children.map(child=>child.title)].some(value=>String(value??'').toLocaleLowerCase().includes(q.query));
  const filtered=all.filter(item=>(q.source==='all'||item.source===q.source)&&(q.group==='all'||item.group===q.group)&&(q.recordId===undefined||item.recordId===q.recordId)&&(q.from===undefined||item.updated>=q.from)&&(q.to===undefined||item.updated<=q.to)&&queryMatches(item)).sort((a,b)=>b.updated-a.updated||b.created-a.created||a.id.localeCompare(b.id));
  const items=filtered.slice(q.offset,q.offset+q.limit);
  // Validation/redaction is bounded to the returned page. These getters are
  // read-only; never use reconcile, due, snapshot or file-receipt verification.
  for(const item of items){
    if(item.source==='goal'&&typeof factory.goals?.get==='function')try{const view=factory.goals.get(sessionId,item.recordId);item.sourceValid=view.sourceValid;item.origin=clean(view.origin??item.origin,60);item.title=clean(view.description);item.result.executionComplete=view.executionComplete===true;item.result.achieved=view.achieved===true;if(!view.sourceValid){item.title='[目标依据已失效]';item.result.unmet=[];for(const step of item.children){step.title='[步骤依据已失效]';if(step.task){step.task={...step.task,title:'[任务依据已失效]',summary:'关联依据已失效，历史正文不在此展示。'};}}}}catch{item.sourceValid=false;item.title='[目标记录已归档或不可用]';item.summary='原始记录当前不可读取，没有重建其内容。';item.result.unmet=[];for(const step of item.children){step.title='[步骤记录不可用]';if(step.task)step.task={...step.task,title:'[任务依据待核对]',summary:'关联依据当前不可读取。'};}}
    if(item.source==='action'&&typeof factory.actions?.get==='function')try{const view=factory.actions.get(sessionId,item.recordId,{content:false});item.sourceValid=view.sourceValid;if(!view.sourceValid){item.title='[文件行动依据已失效]';item.summary='仅保留文件行动状态和回执标识。';}}catch{item.sourceValid=false;item.title='[文件行动记录不可用]';}
  }
  const live=[...(factory.handles??[])].map(handle=>handle.agent).find(agent=>agent?.id===sessionId),active=live?.active&&live.activeCognitionTask?.id;
  const activeTaskId=active&&tasks.get(active)?.status==='executing'?active:[...tasks.values()].find(task=>task.status==='executing')?.taskId??null;
  return {version:1,sessionId,updatedAt:Date.now(),activeTaskId,items,total:filtered.length,offset:q.offset,limit:q.limit,hasMore:q.offset+items.length<filtered.length,counts,sourceCounts,scope:'当前唯一 Session 的留存记录。顶层统计已去除目标内收纳的自主任务；执行尝试不是独立子 Agent，执行完成不等于验收或手机实收。',notes:{warnings,countsBasis:'all-retained-top-level-records-before-filters',totalBasis:'filtered-top-level-records',historicalRetention:'旧自主执行记录可能按现有保留规则归档；缺失记录仅保留实际关联标识。',readOnly:true}};
}
