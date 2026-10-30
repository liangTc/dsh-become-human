import {quotaView} from './quota.mjs';

const HOUR=3600000,DAY=24*HOUR;
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value??null;}catch{return null;}};
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const label=value=>String(value??'unknown').replace(/(?:Bearer\s+\S+|sk-[\w-]{16,})/giu,'[隐藏]').replace(/([?&](?:token|api[_-]?key|access[_-]?token|password|secret|authorization|signature)=)[^\s&#]+/giu,'$1[隐藏]').replace(/[\u0000-\u001f]/gu,'').slice(0,160)||'unknown';
const kinds=[['work-observation','工作观察'],['owner-chat','主人沟通'],['conversation-review','回复校验'],['conversation-summary','会话压缩'],['research-learning','搜索与学习'],['proactive-chat','主动闲聊'],['proactive-care','主动关心'],['knowledge-share','知识分享'],['goal-work','目标推进'],['memory-persona-review','记忆与人格回顾'],['scheduled-task','定时任务'],['other','其他 / 历史未分类']];
const taskKinds={'research':'research-learning','learn-ai':'research-learning','chat':'proactive-chat','care':'proactive-care','share-insight':'knowledge-share'};
const failed=new Set(['failed','output-limit','validation-rejected','interrupted','evidence-insufficient']);

function metrics(){return {attempts:0,requests:0,reportedTokens:0,reportedInputTokens:0,reportedOutputTokens:0,reportedCacheReadTokens:0,reportedCacheWriteTokens:0,reportedUsageRequests:0,derivedTotalRequests:0,partialReportedTokens:0,partialUsageRequests:0,unknownUsageRequests:0,pendingRequests:0,preparedRequests:0,notDispatchedRequests:0,failedRequests:0,cancelledRequests:0,waitRequests:0,settledConservativeTokens:0,pendingReservedTokens:0,conservativeTokens:0,autonomousRequests:0,foregroundRequests:0,detailUnknownRequests:{input:0,output:0,cacheRead:0,cacheWrite:0}};}
function usageOf(raw){
  const usage=parse(raw);if(!usage||typeof usage!=='object'||Array.isArray(usage))return null;
  const input=count(usage.inputTokens),output=count(usage.outputTokens),cacheRead=count(usage.cacheReadTokens),cacheWrite=count(usage.cacheWriteTokens),provided=count(usage.totalTokens);
  // The DSH contract reports uncached input and the two cache classes as
  // disjoint counts. Reasoning tokens are already part of output tokens.
  const components=input!==null&&output!==null&&(usage.cacheReadTokens===undefined||cacheRead!==null)&&(usage.cacheWriteTokens===undefined||cacheWrite!==null)?input+output+(cacheRead??0)+(cacheWrite??0):null;
  const total=provided??(Number.isSafeInteger(components)?components:null);
  return total===null?null:{total,input,output,cacheRead,cacheWrite,basis:provided===null?'components':'provider-total'};
}
export function reportedTokenBreakdown(row){return row?.usage_confidence==='reported'?usageOf(row.usage):null;}
export function isDispatchedAttempt(row){
  if(!row||row.reservationStatus==='released'||row.reservation_status==='released'||row.budgetStatus==='released'||row.usage_confidence==='not-dispatched'||row.state==='prepared')return false;
  const config=parse(row.config);
  const routed=!!config&&typeof config==='object'&&!Array.isArray(config)&&typeof config.provider==='string'&&!!config.provider.trim()&&typeof config.model==='string'&&!!config.model.trim();
  return row.dispatchRecorded===true||row.budgetStatus==='dispatched'||row.hasConfig===1||routed||usageOf(row.usage)!==null;
}
function add(target,row){
  target.attempts++;
  target.settledConservativeTokens+=row.settled;target.pendingReservedTokens+=row.pending;target.conservativeTokens+=row.settled+row.pending;
  if(!row.dispatched){if(row.ended===null)target.preparedRequests++;else target.notDispatchedRequests++;return;}
  target.requests++;
  if(row.foreground)target.foregroundRequests++;else target.autonomousRequests++;
  if(row.ended===null)target.pendingRequests++;
  if(failed.has(row.state))target.failedRequests++;
  if(row.state==='cancelled')target.cancelledRequests++;
  if(row.state==='wait')target.waitRequests++;
  for(const key of ['input','output','cacheRead','cacheWrite'])if(!row.reported||row.usage[key]===null)target.detailUnknownRequests[key]++;
  if(row.reported){
    target.reportedUsageRequests++;target.reportedTokens+=row.usage.total;
    target.reportedInputTokens+=row.usage.input??0;target.reportedOutputTokens+=row.usage.output??0;
    target.reportedCacheReadTokens+=row.usage.cacheRead??0;target.reportedCacheWriteTokens+=row.usage.cacheWrite??0;
    if(row.usage.basis==='components')target.derivedTotalRequests++;
  }else{
    target.unknownUsageRequests++;
    if(row.usage){target.partialUsageRequests++;target.partialReportedTokens+=row.usage.total;}
  }
}
const finish=value=>({...value,actualTokens:value.unknownUsageRequests?null:value.reportedTokens});

function taskIndex(db,id,tables,attempts){
  const tasks=new Map(),goalTasks=new Set();
  const requested=[...new Set(attempts.flatMap(row=>[row.taskId,row.roundId]).filter(value=>typeof value==='string'&&value.length>0&&!value.startsWith('development:')&&!value.startsWith('schedule:')&&!value.startsWith('foreground:')))];
  // A periodic dashboard refresh must scale with the selected time window,
  // rather than repeatedly scanning years of unrelated task/event history.
  const chunks=values=>{const result=[];for(let offset=0;offset<values.length;offset+=300)result.push(values.slice(offset,offset+300));return result;};
  const parameters=values=>values.map(()=>'?').join(',');
  for(const ids of chunks(requested)){
    if(tables.has('autonomy_task'))for(const row of db.prepare("SELECT id,kind,CASE WHEN json_valid(checkpoint) THEN json_extract(checkpoint,'$.goal.id') END AS goalId FROM autonomy_task WHERE agent=? AND id IN ("+parameters(ids)+')').all(id,...ids))tasks.set(row.id,{kind:row.kind,goalId:row.goalId,classification:'task-checkpoint'});
    if(tables.has('human_goal_plan'))for(const row of db.prepare("SELECT DISTINCT t.value AS taskId FROM human_goal_plan p,json_tree(CASE WHEN json_valid(p.steps) THEN p.steps ELSE '[]' END) t WHERE p.agent=? AND t.key='taskId' AND t.type='text' AND t.value IN ("+parameters(ids)+')').all(id,...ids))goalTasks.add(row.taskId);
  }
  // Terminal task rows are bounded independently from retained usage records.
  // Recover only an explicit task kind from a persisted event, never by guessing
  // from a private question, answer or source title.
  if(tables.has('human_event'))for(const ids of chunks(requested.filter(taskId=>!tasks.has(taskId))))for(const row of db.prepare("SELECT task_id AS taskId,CASE WHEN json_valid(data) THEN json_extract(data,'$.kind') END AS taskKind FROM human_event WHERE agent=? AND task_id IN ("+parameters(ids)+") AND kind IN ('task-created','task-ready','task-executing','task-completed','task-failed','task-cancelled','task-suspended','task-waiting-budget') ORDER BY time,id").all(id,...ids))if(!tasks.has(row.taskId)&&Object.hasOwn(taskKinds,row.taskKind))tasks.set(row.taskId,{kind:row.taskKind,classification:'task-event'});
  return {tasks,goalTasks};
}
function category(row,index){
  if(row.contextKind==='conversation-review')return 'conversation-review';
  if(row.contextKind==='conversation-summary'||String(row.taskId??'').startsWith('conversation-summary:'))return 'conversation-summary';
  if(row.foreground)return 'owner-chat';
  const taskId=typeof row.taskId==='string'?row.taskId:typeof row.roundId==='string'?row.roundId:'';
  if(taskId.startsWith('work-observation:')||row.contextKind==='work-observation')return 'work-observation';
  if(taskId.startsWith('development:')||row.contextKind==='development-review')return 'memory-persona-review';
  const task=index.tasks.get(taskId);
  if(task?.goalId||index.goalTasks.has(taskId))return 'goal-work';
  if(taskId.startsWith('schedule:')||row.lane==='scheduled')return 'scheduled-task';
  return Object.hasOwn(taskKinds,task?.kind)?taskKinds[task.kind]:'other';
}
function signedIndex(ledger){
  const dispatched=new Set();
  for(const row of ledger?.rows??[])if(row.kind==='budget-dispatch'){const data=parse(row.data);if(typeof data?.rid==='string')dispatched.add(data.rid);}
  return dispatched;
}
function normalized(row,entry,signedDispatch){
  const usage=usageOf(row.usage),confidence=row.usage_confidence;
  const released=entry?.status==='released'||row.reservationStatus==='released';
  // The durable dispatch ticket is a started call, not proof that a network
  // request reached the provider or that a cancelled call was free.
  const dispatched=!released&&isDispatchedAttempt({...row,dispatchRecorded:signedDispatch.has(row.id),budgetStatus:entry?.status});
  const amount=released?0:count(entry?.amount??row.amount)??0;
  const reservationStatus=entry?.status==='prepared'||entry?.status==='dispatched'?'pending':entry?.status??row.reservationStatus;
  const foreground=row.lane==='foreground'||row.budgetClass==='foreground'||(row.lane==null&&row.admittedCount>0);
  return {...row,foreground,dispatched,usage,reported:dispatched&&confidence==='reported'&&usage!==null,ended:row.ended??null,settled:reservationStatus==='settled'?amount:0,pending:reservationStatus==='pending'?amount:0};
}
function rowsFor(db,id,start,end,tables){
  if(!tables.has('attempt'))return [];
  const reservation=tables.has('reservation');
  const sql=`SELECT a.id,a.state,a.usage,a.usage_confidence,a.started,a.ended,
    CASE WHEN json_valid(a.request) THEN json_extract(a.request,'$.taskId') END AS taskId,
    CASE WHEN json_valid(a.request) THEN json_extract(a.request,'$.roundId') END AS roundId,
    CASE WHEN json_valid(a.request) THEN json_extract(a.request,'$.lane') END AS lane,
    CASE WHEN json_valid(a.request) THEN json_extract(a.request,'$.budgetClass') END AS budgetClass,
    CASE WHEN json_valid(a.request) THEN json_array_length(a.request,'$.admittedIds') END AS admittedCount,
    CASE WHEN json_valid(a.request) THEN json_extract(a.request,'$.context.kind') END AS contextKind,
    CASE WHEN json_valid(a.config) THEN json_extract(a.config,'$.provider') END AS provider,
    CASE WHEN json_valid(a.config) THEN json_extract(a.config,'$.model') END AS model,
    CASE WHEN json_valid(a.config) THEN CASE WHEN json_type(a.config,'$.provider')='text' AND length(trim(json_extract(a.config,'$.provider')))>0 AND json_type(a.config,'$.model')='text' AND length(trim(json_extract(a.config,'$.model')))>0 THEN 1 ELSE 0 END ELSE 0 END AS hasConfig,
    ${reservation?'r.amount,r.status':'NULL AS amount,NULL'} AS reservationStatus
    FROM attempt a ${reservation?'LEFT JOIN reservation r ON r.id=a.id AND r.agent=a.agent':''}
    WHERE a.agent=? AND a.started>=? AND a.started<? ORDER BY a.started,a.id`;
  return db.prepare(sql).all(id,start,end);
}
function quotaSnapshot(factory,id,now,dispatch,tables){
  const j=factory.journal,ledger=j.safety,policy=factory.autonomy.settings(id);
  const ids=ledger?.autonomyAgents?.(id)??new Set([id]);
  let signedNow=Math.max(now,j.value(id,'autonomyTimeHighWater',0));
  for(const entry of ledger?.budget?.entries.values()??[])if(ids.has(entry.agent))signedNow=Math.max(signedNow,count(entry.created)??0);
  const view=quotaView(ledger??{autonomyEntries:()=>[],autonomyGrants:()=>[]},id,policy,signedNow);
  const entries=ledger?.autonomyEntries?.(id,view.windowStart).filter(entry=>entry.created<=signedNow&&entry.status!=='released')??[];
  let reportedTokens=0,unknownUsageRequests=0,pendingReservedTokens=0,settledConservativeTokens=0,dispatchedRequests=0,preparedRequests=0,partialReportedTokens=0,derivedTotalRequests=0;
  const get=tables.has('attempt')?j.db.prepare('SELECT id,state,usage,usage_confidence,ended,config IS NOT NULL AS hasConfig FROM attempt WHERE id=?'):null;
  for(const entry of entries){
    const row=get?.get(entry.rid),usage=usageOf(row?.usage),isDispatched=dispatch.has(entry.rid)||entry.status==='dispatched'||entry.status==='settled';
    if(entry.status==='settled')settledConservativeTokens+=count(entry.amount)??0;else pendingReservedTokens+=count(entry.amount)??0;
    if(isDispatched){dispatchedRequests++;if(row?.usage_confidence==='reported'&&usage){reportedTokens+=usage.total;if(usage.basis==='components')derivedTotalRequests++;}else{unknownUsageRequests++;if(usage)partialReportedTokens+=usage.total;}}
    else preparedRequests++;
  }
  const available=!!ledger;
  return {available,now:signedNow,windowStart:view.windowStart,windowEnd:view.windowEnd,resetAt:view.resetAt,budgetWindow:view.budgetWindow,quotaEnabled:view.quotaEnabled,
    tokenLimit:view.tokenLimit,requestLimit:view.requestLimit,roundLimit:view.roundLimit,
    reservedTokens:available?settledConservativeTokens+pendingReservedTokens:null,requests:available?entries.length:null,
    rounds:available?new Set(entries.map(entry=>entry.roundId??'legacy:'+entry.rid)).size:null,
    reportedTokens:available?reportedTokens:null,unknownUsageRequests:available?unknownUsageRequests:null,
    dispatchedRequests:available?dispatchedRequests:null,preparedRequests:available?preparedRequests:null,
    pendingReservedTokens:available?pendingReservedTokens:null,settledConservativeTokens:available?settledConservativeTokens:null,
    partialReportedTokens:available?partialReportedTokens:null,derivedTotalRequests,
    legacyRoundEstimate:available?entries.filter(entry=>!entry.roundId).length:null,
    includesRetiredSessionLedger:ids.size>1};
}

// A read-only view of existing requests and durable budget tickets. Opening the
// page never advances a clock marker, runs a model, searches, or edits a quota.
export function usageStatistics(factory,id,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||!['24h','current-window'].includes(input.period??'24h'))throw new Error('INVALID_USAGE_STATISTICS_QUERY');
  const j=factory.journal,db=j.db;j.assertAdmitted(id);
  const generatedAt=Date.now(),period=input.period??'24h',tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  const dispatched=signedIndex(j.safety),currentQuota=quotaSnapshot(factory,id,generatedAt,dispatched,tables),end=period==='24h'?generatedAt:currentQuota.now+1,start=period==='24h'?Math.max(0,end-DAY):currentQuota.windowStart;
  const rows=rowsFor(db,id,start,end,tables),policy=factory.autonomy.settings(id),index=taskIndex(db,id,tables,rows),overall=metrics(),categories=new Map(kinds.map(([key,text])=>[key,{id:key,label:text,...metrics()}])),models=new Map(),hourly=[];
  // Exact local-hour boundaries are preferable to a UTC-hour shift in regions
  // with a non-integral UTC offset. The first and last buckets may be partial.
  const offset=(policy.timeZoneOffsetMinutes??480)*60000;
  for(let cursor=start;cursor<end;){const next=Math.min(end,(Math.floor((cursor+offset)/HOUR)+1)*HOUR-offset);hourly.push({start:cursor,end:next,...metrics()});cursor=next;}
  let unclassified=0,legacyDispatch=0,invalidReported=0;
  const entries=j.safety?.budget?.entries??new Map();
  for(const source of rows){
    const row=normalized(source,entries.get(source.id),dispatched),key=category(row,index),modelKey=JSON.stringify([label(row.provider),label(row.model)]);
    if(key==='other')unclassified++;
    if(row.dispatched&&!dispatched.has(row.id))legacyDispatch++;
    if(row.usage_confidence==='reported'&&!row.usage)invalidReported++;
    if(!models.has(modelKey))models.set(modelKey,{provider:label(row.provider),model:label(row.model),...metrics()});
    add(overall,row);add(categories.get(key),row);add(models.get(modelKey),row);
    const bucket=hourly.find(hour=>row.started>=hour.start&&row.started<hour.end);if(bucket)add(bucket,row);
  }
  const warnings=[];
  if(!tables.has('attempt'))warnings.push({code:'ATTEMPT_TABLE_UNAVAILABLE'});
  if(!currentQuota.available)warnings.push({code:'SIGNED_LEDGER_UNAVAILABLE'});
  if(unclassified)warnings.push({code:'WORK_CATEGORY_UNAVAILABLE',count:unclassified});
  if(legacyDispatch)warnings.push({code:'LEGACY_DISPATCH_INFERRED',count:legacyDispatch});
  if(invalidReported)warnings.push({code:'REPORTED_USAGE_INVALID_OR_MISSING',count:invalidReported});
  if(currentQuota.now>generatedAt)warnings.push({code:'QUOTA_CLOCK_HIGH_WATER'});
  return {version:1,period,generatedAt,range:{start,end,timeZoneOffsetMinutes:policy.timeZoneOffsetMinutes??480,kind:period==='24h'?'rolling-24h':'autonomous-quota-window',attribution:'attempt-start'},overall:finish(overall),categories:[...categories.values()].map(finish),models:[...models.values()].map(finish).sort((a,b)=>b.reportedTokens-a.reportedTokens||b.requests-a.requests||a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model)),hourly:hourly.map(finish),currentQuota,
    notes:[
      '按模型尝试开始时间归入所选半开区间 [开始, 结束)，同一请求只计一次。选题与执行按同一实际任务归类；目标关联优先归目标推进。',
      '已报告 token 仅累计有效的最终供应商报告；没有总数时以未缓存输入、输出、缓存读取和写入分项相加，不额外累加推理 token。未知用量不会被当作零消耗。',
      '中途报告是取消或失败时留下的未确认最终用量，单独展示，不重复加入已报告 token。进行中、取消、失败均可能产生供应商费用。',
      '保守占额为本地已结算占额加进行中预留，并非实际 token 或账单；已释放的预留不计。当前自主额度仅使用签名账本，包含未发出的有效预留，主人沟通不占自主池。',
      '统计只覆盖本 Human 保留的模型尝试；当前额度账本可能包含退休会话的延续用量。历史记录被删除后无法重建类别和完整用量。',
      '本地命令、静态提醒、搜索请求、文件和 MCP 工具调用本身没有模型尝试时不计模型请求；搜索、外部工具、订阅和其他供应商费用未知，本页不是账单。'
    ],warnings};
}
