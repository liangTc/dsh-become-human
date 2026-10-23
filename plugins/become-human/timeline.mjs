const parse=s=>{try{return JSON.parse(s);}catch{return null;}};
const text=(s,n=220)=>typeof s==='string'?s.replace(/([?&](?:token|api_key|access_token)=)[^\s&]+/giu,'$1[隐藏]').replace(/sk-[\w-]{16,}/gu,'[隐藏]').slice(0,n):'';
const labels={
 'development-review-started':'回顾已有经历与记忆','development-review-completed':'保存本次经历回顾','development-review-suspended':'保存回顾进度，优先与你交流','development-review-failed':'本次回顾未完成，等待明确重试','development-review-interrupted':'回顾遇到运行中断，保留记录','persona-development-applied':'形成一小步有依据的人格偏移','persona-development-observing':'暂时保留观察，尚未改变人格','persona-development-reverted':'撤回一条人格偏移','persona-development-invalidated':'依据变化，撤去对应人格偏移','memory-lifecycle-summary-committed':'整理可追溯摘要，保留原文',
 'action-proposed':'整理报告草稿，等待单独批准','action-approved':'收到这一版本的文件写入授权','action-executing':'开始写入已批准的报告','action-completed':'生成文件并核对哈希','action-blocked':'文件行动需要处理，没有继续写入','action-cancelled':'取消文件行动','action-expired':'文件写入授权到期','action-notified':'在唯一会话告知行动结果','goal-report-prepared':'将学习成果整理成待批准报告',
 'owner-command-recorded':'记录本地指令的处理结果',
 'context-assembled':'整理本轮现状与相关记忆','task-created':'产生一个待确认的方向','direction-selected':'确定本轮方向','task-ready':'准备继续任务','task-executing':'开始执行任务','task-completed':'完成任务','task-suspended':'保存进度，稍后继续','task-cancelled':'结束本次任务','task-failed':'任务遇到问题',
 'attempt-selected':'完成方向选择','attempt-completed':'完成模型请求','attempt-executed':'完成任务分析','attempt-cancelled':'停止当前请求，优先回应你','attempt-validation-rejected':'结果未满足要求，没有发布','learning-rejected':'学习结果未满足要求，没有保存','learning-committed':'保存学习笔记','learning-remembered':'将学习结果记入记忆','learning-evidence-insufficient':'发现证据不足，没有保存结论','research-unavailable':'本次没有取得可用资料','response-published':'在会话中发出消息','brain-wait':'检查后决定等待','timer-wake':'到了检查时间','autonomy-deferred':'等待更合适的时机','autonomy-plan-invalidated':'根据新信息调整方向','autonomy-turn-ended':'本轮执行中断','schedule-executing':'到点执行定时任务','schedule-delivered':'将定时任务结果写入会话','schedule-blocked':'定时任务等待处理','social-contact-committed':'留下本轮话题，调整下次交流时机','social-publication-deferred':'发送前发现时机变化，暂不打扰'
};
const reasonLabel=r=>({'awaiting-owner-reply':'已有多条主动联系未回复，先等你回应','social-cadence':'等待下一次闲聊时机','contact-minimum-gap':'与上一条主动消息保持间隔','quiet-hours':'静默时段，暂不打扰','social-task-backoff':'这一轮暂不闲聊，稍后再看','social-topics-cooling':'近期话题正在冷却','no-eligible-event':'暂时没有值得执行的新事项','selection-wait':'本轮决定暂不行动','insufficient-source-evidence':'已有资料不足以支持结论','declared-insufficient':'阅读后发现材料不能回答当前问题','executor-wait':'执行后决定暂不发表','INVALID_CHAT_OUTPUT':'聊天格式不合要求，没有发送','REPEATED_SOCIAL_TOPIC':'话题与近期交流重复，暂不发送','SOCIAL_REPLY_PRESSURE':'表达包含催答，本轮没有发送','SOCIAL_TASK_ROLE_MISMATCH':'把自主问题误作主人提问，本轮没有发送','INVALID_PROACTIVE_OUTPUT':'输出未满足分享要求，没有发送','INVALID_TASK_OUTPUT':'输出格式未满足要求，本轮没有继续','UNSUPPORTED_LEARNING_EVIDENCE':'学习证据编号未通过校验，本任务已隔离','UNSUPPORTED_LEARNING_CLAIM':'学习引文未通过校验，本任务已隔离','INVALID_LEARNING_CLAIM_COUNT':'学习结论数量不合要求，本任务已隔离','INVALID_LEARNING_CLAIM_TEXT':'学习结论正文不合要求，本任务已隔离','AUTONOMOUS_BUDGET_EXHAUSTED':'等待自主额度','USER_PREEMPTED':'你发来了消息，先与你交流','AUTONOMOUS_ROUND_TIMEOUT':'本轮已达到执行时长上限','AUTONOMY_PAUSED':'自主执行已暂停'}[r]??(/^[A-Z_]{3,64}$/.test(r)?'这一步需要进一步检查':text(r)));
const taskNames={'research':'自主了解外部内容','learn-ai':'阅读与学习','share-insight':'与你分享一个发现','care':'想关心你一下','chat':'主动找你聊聊'};
function memoryView(m){
 const p=parse(m.payload),active=m.status==='active',changed=m.version>1;
 const description=!active?(m.status==='deleted'?'这条记忆已被遗忘':'这条记忆当前已失效'):changed?'这条记忆后来有过更新，可在记忆页查看当前版本':text(p?.summary??p?.userSaid??p?.value??p?.description??p?.relevance??JSON.stringify(p),240);
 return {id:m.id,type:m.type,truth:m.truth,status:m.status,version:m.version,title:!active?'记忆状态已变化':text(p?.title??({'episode':'记住一段与你的对话',fact:'记录你明确表达的偏好',working:'保存一条工作记忆',goal:'记住一个目标',skill:'留下一个学习结论'}[m.type]??'保存记忆'),100),description,created:m.valid_from};
}
export function brainTimeline(management,agent,input={}){
 const j=management.journal,db=j.db,now=Date.now(),offset=management.factory.autonomy.settings(agent).timeZoneOffsetMinutes,day=Math.floor((now+offset*60000)/86400000)*86400000-offset*60000;
 const from=input.from==null||input.from===''?day:Number(input.from),to=input.to==null||input.to===''?now:Number(input.to),limit=Number(input.limit??20);
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<from||to-from>31*86400000||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('INVALID_TIMELINE_RANGE');
 if(input.category&&!['autonomous','chat','memory','schedule','check','action'].includes(input.category)||input.status&&!['success','running','wait','suspended','failed'].includes(input.status)||input.query&&(typeof input.query!=='string'||input.query.length>160))throw new Error('INVALID_TIMELINE_FILTER');
 const groups=new Map(),ensure=(id,kind,time)=>{if(!groups.has(id))groups.set(id,{id,kind,time,started:time,ended:time,status:'running',title:'',question:'',value:'',actions:[],memories:[],noteIds:[],requests:0,reportedTokens:0,waitChecks:0});const g=groups.get(id);g.time=Math.max(g.time,time);g.started=Math.min(g.started,time);g.ended=Math.max(g.ended,time);return g;};
 const rawEvents=db.prepare('SELECT * FROM human_event WHERE agent=? AND time>=? AND time<=? ORDER BY time DESC,id DESC LIMIT 4001').all(agent,from,to),events=rawEvents.slice(0,4000).reverse(),rawAttempts=db.prepare("SELECT id,turn,state,started,ended,usage,error,json_extract(request,'$.taskId') AS taskId,json_extract(request,'$.roundId') AS roundId,json_extract(request,'$.lane') AS lane,json_extract(request,'$.admittedIds') AS admitted FROM attempt WHERE agent=? AND started<=? AND COALESCE(ended,started)>=? ORDER BY started LIMIT 2001").all(agent,to,from),attempts=rawAttempts.slice(0,2000),requestGroups=new Map(),messageGroups=new Map();
 for(const a of attempts){
   const scheduled=a.taskId?.startsWith('schedule:'),id=scheduled?a.roundId??a.taskId:a.taskId?'task:'+a.taskId:'chat:'+a.turn;
   const g=ensure(id,a.taskId?.startsWith('development:')?'memory':scheduled?'schedule':a.taskId?'autonomous':'chat',Math.min(a.ended??a.started,to));g.started=Math.min(g.started,Math.max(a.started,from));g.taskId=scheduled?null:a.taskId;g.requests++;const usage=parse(a.usage);g.reportedTokens+=usage?.totalTokens??(usage?(usage.inputTokens??0)+(usage.outputTokens??0):0);requestGroups.set(a.id,id);
   for(const mid of parse(a.admitted)??[])messageGroups.set(mid,id);
   if(!g.title)g.title=a.taskId?.startsWith('development:')?'回顾经历与记忆':scheduled?'执行一个定时任务':a.taskId?'推进一个自主任务':'与你交流';
   if(a.lane==='foreground'){const userIds=parse(a.admitted)??[];const messages=userIds.map(mid=>db.prepare("SELECT text FROM outbox WHERE agent=? AND event_key=?").get(agent,'user:'+mid)?.text).filter(Boolean);g.question=messages.length?'回应你：'+text(messages.join('；'),180):'回应你的消息';g.status=a.state==='completed'?'success':['failed','validation-rejected'].includes(a.state)?'failed':a.state==='cancelled'?'suspended':'running';}
 }
 for(const e of events){
   const d=parse(e.data)??{};let id,kind;
   if(d.actionId&&(/^action-|^goal-report-/.test(e.kind))){id='action:'+d.actionId;kind='action';}
   else if(e.kind==='owner-command-recorded'){id='owner-command:'+d.inputId;kind='chat';messageGroups.set(d.inputId,id);}
   else if(d.inputId&&messageGroups.has(d.inputId)){id=messageGroups.get(d.inputId);kind='chat';}
   else if(d.scheduleId&&['schedule-executing','schedule-delivered','schedule-blocked'].includes(e.kind)){id=d.roundId??('schedule:'+d.scheduleId+':'+(d.occurrenceAt??e.time));kind='schedule';}
   else if(e.task_id){id=e.task_id.startsWith('schedule:')?(requestGroups.get(e.request_id)??e.round_id??e.task_id):'task:'+e.task_id;kind=e.task_id.startsWith('development:')?'memory':e.task_id.startsWith('schedule:')?'schedule':'autonomous';}
   else if(requestGroups.has(e.request_id)){id=requestGroups.get(e.request_id);kind=id.startsWith('chat:')?'chat':id.startsWith('schedule:')?'schedule':'autonomous';}
   else if(e.kind.startsWith('persona-development-')||e.kind.startsWith('memory-lifecycle-')){id='memory-lifecycle:'+Math.floor(e.time/3600000)*3600000;kind='memory';}
   else if(['brain-wait','timer-wake'].includes(e.kind)){id='check:'+Math.floor(e.time/3600000)*3600000;kind='check';}
   else continue;
   const g=ensure(id,kind,e.time);if(kind==='autonomous'){g.taskId=e.task_id;g.title=taskNames[d.kind]??g.title??'自主活动';}
   if(e.kind==='owner-command-recorded'){g.title=d.command==='local-goal'?'处理你的目标指令':'处理你的定时任务请求';g.question='按你明确指定的内容处理，不调用模型';g.status='success';}
   if(kind==='action'){g.actionId=d.actionId;g.title=text(d.title,120)||'推进报告文件行动';g.question='整理有效学习材料，预览和批准后写入这一版本的报告';g.value='授权绑定具体内容、路径和哈希，不扩大到其他文件或系统命令。';}
   if(kind==='schedule'){g.title=text(d.title,120)||g.title||'定时任务';g.scheduleId=d.scheduleId??e.task_id?.slice(9);}
   if(d.question){g.question=text(d.question,240);g.value=text(d.value,400);}
   if(d.checkpoint?.plan){g.question=text(d.checkpoint.plan.question,240);g.value=text(d.checkpoint.plan.value,400);}
   if(e.kind==='direction-selected'){g.question=text(d.question,240);g.value=text(d.value,400);if(d.decision==='wait')g.status='wait';}
   if(d.noteId&&!g.noteIds.includes(d.noteId))g.noteIds.push(d.noteId);
   if(kind==='check'){g.title='例行检查';g.question='检查有没有需要处理的新事';if(e.kind==='brain-wait')g.waitChecks++;g.status=g.waitChecks?'wait':'success';if(g.waitChecks){g.title='检查后选择等待';g.value=reasonLabel(d.social?.reason&&d.social.reason!=='social-disabled'?d.social.reason:d.reason)||g.value;}}
   // A completed checkpoint can retain a previous suspension reason. Keep the
   // original suspension event, but do not label completion with that history.
   if(labels[e.kind])g.actions.push({id:e.id,time:e.time,label:labels[e.kind],detail:e.kind==='task-completed'?'':reasonLabel(d.reason??d.code??d.error??''),status:e.status,requestId:e.request_id});
   if(['task-completed','schedule-delivered','development-review-completed'].includes(e.kind))g.status='success';
   if(['task-ready','task-executing','schedule-executing'].includes(e.kind)||e.kind==='direction-selected'&&d.decision==='execute')g.status='running';
   if(['development-review-failed','development-review-interrupted','task-failed','autonomy-turn-ended','schedule-blocked','attempt-validation-rejected'].includes(e.kind))g.status='failed';
   if(['development-review-suspended','task-suspended','attempt-cancelled'].includes(e.kind))g.status='suspended';
   if(['task-cancelled','learning-evidence-insufficient','autonomy-deferred'].includes(e.kind))g.status='wait';
 }
 const rawMemories=db.prepare('SELECT id,type,payload,truth,refs,status,version,valid_from FROM memory_record WHERE agent=? AND valid_from>=? AND valid_from<=? ORDER BY valid_from LIMIT 1001').all(agent,from,to);
 for(const m of rawMemories.slice(0,1000)){
   const note=db.prepare('SELECT id,data FROM learning_note WHERE agent=? AND memory_id=?').get(agent,m.id),tid=note?parse(note.data)?.taskId:null,refs=parse(m.refs)??[];
   const id=tid?'task:'+tid:refs.map(r=>messageGroups.get(r)).find(Boolean)??'memory:'+m.id;
   if(m.status!=='active'&&id.startsWith('memory:')&&input.category!=='memory')continue;
   const g=ensure(id,tid?'autonomous':id.startsWith('chat:')?'chat':'memory',m.valid_from);
   if(!g.title)g.title=tid?'学习并留下记忆':'保存一条记忆';if(id.startsWith('memory:'))g.status='success';g.memories.push(memoryView(m));if(note&&!g.noteIds.includes(note.id))g.noteIds.push(note.id);
 }
 for(const g of groups.values()){
   if(g.kind==='action'){try{const action=management.factory.actions.get(agent,g.actionId);g.title=action.sourceValid?action.title:'报告材料已失效';g.status=({proposed:'wait',approved:'wait',executing:'running',completed:'success',blocked:'failed',cancelled:'suspended',expired:'failed'})[action.status]??'wait';g.artifact=action.sourceValid?action.receipt:null;}catch{g.status='failed';}}
   if(g.taskId){const t=management.factory.autonomy.getTask(g.taskId);g.title=taskNames[t?.kind]??g.title??'自主活动';}
   if(!g.title)g.title=g.kind==='autonomous'?'自主活动':g.kind==='chat'?'与你交流':'定时任务';
   if(!g.question)g.question=g.kind==='autonomous'?'这段活动没有保留下问题摘要':g.kind==='schedule'?'处理你设定的定时事项':g.kind==='memory'?'整理并保存记忆':'检查当前时机';
   g.actions=g.actions.slice(-30);g.memories=g.memories.slice(0,20);
   if(g.kind==='check'&&g.actions.length>3)g.actions=[{time:g.started,label:'在这段时间检查了 '+Math.max(g.waitChecks,g.actions.length)+' 次',detail:g.value,status:'wait'}];
 }
 const query=input.query?.toLowerCase(),all=[...groups.values()].filter(g=>(!input.category||g.kind===input.category)&&(!input.status||g.status===input.status)&&(!query||JSON.stringify({title:g.title,question:g.question,value:g.value,actions:g.actions,memories:g.memories}).toLowerCase().includes(query))).sort((a,b)=>b.time-a.time||b.id.localeCompare(a.id,'en'));
 let filtered=all;
 if(input.before!==undefined){const before=Number(input.before);if(!Number.isSafeInteger(before)||typeof input.beforeId!=='string'||input.beforeId.length>160)throw new Error('INVALID_TIMELINE_CURSOR');filtered=all.filter(g=>g.time<before||g.time===before&&g.id.localeCompare(input.beforeId,'en')<0);}
 const items=filtered.slice(0,limit),last=items.at(-1);
 return {from,to,timeZoneOffsetMinutes:offset,total:all.length,items,hasMore:filtered.length>limit,next:last?{before:last.time,beforeId:last.id}:null,partial:rawEvents.length>4000||rawAttempts.length>2000||rawMemories.length>1000,tracingSince:j.value(agent,'nativeTracingSince',null),totals:{questions:all.filter(g=>g.kind==='autonomous'&&g.question!=='这段活动没有保留下问题摘要').length,actions:all.filter(g=>g.status==='success'&&!['memory','check'].includes(g.kind)).length,memories:all.reduce((n,g)=>n+g.memories.length,0),waits:all.filter(g=>g.status==='wait').length},basis:'Recorded questions and plans, execution receipts and memory records; no generated private reasoning.'};
}
