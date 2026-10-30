import React,{useEffect,useMemo,useState} from 'react';
import {ToolJobDetail} from './native-tools';
import {ActionDetail} from './native-actions';
import {DisclosureChevron,useDisclosure} from './native-disclosure';

const sources:Record<string,string>={autonomy:'自主执行',goal:'目标计划',schedule:'定时任务',tool:'工具作业',action:'文件产物'};
const groups=[['pending','待执行'],['running','执行中'],['attention','需处理'],['done','已结束']];
const labels:Record<string,string>={ready:'已排队',executing:'执行中',running:'执行中',suspended:'保留进度，等待续行','waiting-budget':'等待额度',pending:'尚未开始',proposed:'待确认',active:'已激活',paused:'已暂停',blocked:'受阻','needs-evidence':'需要补证','awaiting-review':'等待验收','awaiting-approval':'等待批准',completed:'执行完成',failed:'执行失败',cancelled:'已终止',expired:'已到期',unknown:'结果未知',queued:'已排队',approved:'已批准',committed:'已写入会话',staged:'待提交',prepared:'待批准',rejected:'未批准',draft:'草稿',archived:'记录已归档'};
const time=(value:any)=>Number.isFinite(Number(value))&&Number(value)>0?new Date(Number(value)).toLocaleString('zh-CN',{hour12:false}):'未记录';
const list=(value:any):any[]=>Array.isArray(value)?value:[];
const text=(value:any):string=>typeof value==='string'?value:typeof value==='number'?String(value):value?.summary??value?.text??value?.title??value?.reason??'';
const origin=(row:any)=>row.origin==='owner'?'主人指定':row.origin==='agent'?'Agent 提出':row.origin==='autonomous'?'自主触发':row.origin==='foreground'?'聊天触发':'';
const sectionFor:Record<string,string>={goal:'goals',schedule:'tasks',tool:'tools',action:'actions'};

function useTaskBoard(api:any,sessionId:string,filters:any,nonce:number){
  const key=JSON.stringify(filters),[result,setResult]=useState<any>({data:null,error:'',loading:true,key:'',sessionId});
  useEffect(()=>{
    let live=true,inflight=false;
    const load=async()=>{
      if(inflight)return;inflight=true;
      setResult((old:any)=>({data:old.key===key&&old.sessionId===sessionId?old.data:null,error:'',loading:true,key,sessionId}));
      try{const data=await api.read({kind:'task-board',...filters});if(data.sessionId!==sessionId)throw Error('STALE_SESSION');if(live)setResult({data,error:'',loading:false,key,sessionId});}
      catch(error:any){if(live)setResult((old:any)=>({...old,error:error.message??'任务看板读取失败',loading:false}));}
      finally{inflight=false;}
    };
    void load();const timer=setInterval(()=>void load(),15000);
    return ()=>{live=false;clearInterval(timer);};
  },[api,sessionId,key,nonce]);
  return result.key===key&&result.sessionId===sessionId?result:{data:null,error:'',loading:true};
}

function ResultSummary({row,ui}:any){
  const r=row.result??{},notes=list(r.notes??r.noteIds),receipt=r.fileReceipt??r.receipt,{Band}=ui;
  return <div className="hn-task-result">
    {text(r.summary??r.meaning)?<p>{text(r.summary??r.meaning)}</p>:null}
    {row.source==='goal'?<p>步骤执行：{['cancelled','expired'].includes(row.status)?'已终止':r.executionComplete?'已结束':'尚未全部结束'} · 目标验收：{row.status==='cancelled'?'目标已取消':row.status==='expired'?'目标已到期':r.achieved===true?'符合已配置的验收规则':r.achieved===false?'尚未达成':'待核对'}</p>:null}
    {notes.length?<p>关联笔记 {notes.length} 份{r.semanticVerified===false?' · 内容完整性尚未确认':''}</p>:null}
    {r.noteId?<p className="hn-mono">笔记 {r.noteId}</p>:null}
    {row.source==='schedule'?<p>{['pending','paused','blocked','staged'].includes(row.status)?'下次计划':'原计划'} {time(r.nextAt)} · 已写入会话 {r.deliveryCount??0} 次{r.lastCommittedAt?' · 最近 '+time(r.lastCommittedAt):''}</p>:null}
    {receipt?<dl className="hn-board-facts">{[['文件',receipt.path],['字节数',receipt.bytes],['SHA-256',receipt.digest??receipt.sha256]].filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=><div key={k as string}><dt>{k}</dt><dd className="hn-mono">{String(v)}</dd></div>)}</dl>:null}
    {r.phoneDeliveryState?<p>手机投递：{({sent:'供应商已接受',unknown:'投递未知',failed:'发送失败',pending:'待发送'} as any)[r.phoneDeliveryState]??r.phoneDeliveryState}；实际收到以本人确认为准。</p>:null}
    {row.status==='unknown'?<Band>当前结果未知。请核对原工具回执，不应直接重试写操作。</Band>:null}
    {!text(r.summary??r.meaning)&&!notes.length&&!r.noteId&&!receipt&&row.source!=='goal'?<p className="hn-board-caption">{row.group==='done'?'没有可展示的结果摘要，请查看原记录。':'尚未取得最终结果。'}</p>:null}
  </div>;
}

export function taskTreeDisclosureIds(rows:any[],depth=0):string[]{
  if(!Array.isArray(rows)||depth>4)return [];
  return rows.flatMap((step:any,index:number)=>{const key=String(step.id??'step-'+depth+'-'+index);return ['step:'+key,'step-attempts:'+key,...list(step.attempts??step.task?.attempts).map((attempt:any,i:number)=>'step-attempt:'+key+':'+(attempt.id??i)),...taskTreeDisclosureIds(step.children,depth+1)];});
}

function TaskTree({rows,ui,onTask,disclosure,depth=0}:any){
  if(!list(rows).length||depth>4)return null;
  return <ol className="hn-task-tree">{rows.map((step:any,index:number)=>{
    const taskId=step.taskId??step.task?.recordId??step.task?.taskId??step.task?.id,attempts=list(step.attempts??step.task?.attempts),key=String(step.id??'step-'+depth+'-'+index),node='step:'+key,attemptNode='step-attempts:'+key;
    return <li key={key}><details className="hn-compact-node" open={disclosure.isOpen(node)} onToggle={event=>disclosure.setOpen(node,event.currentTarget.open)}><summary><DisclosureChevron/><strong>{index+1}. {step.title??step.question??'步骤'}</strong><span className="hn-board-status">{step.statusLabel??labels[step.status]??step.status??'未记录'}</span></summary><div className="hn-compact-node-content">
      {step.summary?<p>{step.summary}</p>:null}{step.reason?<p className="hn-note">原因：{ui.errorText(text(step.reason))}</p>:null}
      {step.task?<p className="hn-board-caption">关联执行：{step.task.statusLabel??labels[step.task.status]??step.task.status??'未记录'}</p>:null}
      {step.noteId??step.result?.noteId?<p className="hn-board-caption hn-mono">已关联笔记 {step.noteId??step.result.noteId}</p>:null}{step.actionId?<p className="hn-board-caption hn-mono">文件产物 {step.actionId}</p>:null}
      {taskId?<ui.Button onClick={()=>onTask(taskId)}>查看执行记录</ui.Button>:null}
      {attempts.length?<details className="hn-compact-node hn-compact-node-nested" open={disclosure.isOpen(attemptNode)} onToggle={event=>disclosure.setOpen(attemptNode,event.currentTarget.open)}><summary><DisclosureChevron/><strong>执行尝试 · {attempts.length} 次</strong></summary><ul className="hn-task-attempts">{attempts.map((attempt:any,i:number)=>{const id='step-attempt:'+key+':'+(attempt.id??i);return <li key={attempt.id??i}><details open={disclosure.isOpen(id)} onToggle={event=>disclosure.setOpen(id,event.currentTarget.open)}><summary>第 {i+1} 次 · {attempt.statusLabel??labels[attempt.status??attempt.state]??attempt.status??attempt.state??'已记录'}</summary><p>{time(attempt.started??attempt.created)}{attempt.error??attempt.reason?' · '+ui.errorText(text(attempt.error??attempt.reason)):''}</p></details></li>;})}</ul><p className="hn-board-caption">执行尝试是同一任务的调用记录。</p></details>:null}
      <TaskTree rows={step.children} {...{ui,onTask,disclosure}} depth={depth+1}/>
    </div></details></li>;
  })}</ol>;
}

function BoardDetail({row:initial,api,sessionId,ui,onClose,onTask,onSection,onTool,onAction}:any){
  const result=useTaskBoard(api,sessionId,{source:initial.source,recordId:initial.recordId,limit:1},0),row=result.data?.items?.[0]??initial;
  const {Detail,Button}=ui,source=row.source,taskId=source==='autonomy'?row.taskId??row.recordId:null,destination=sectionFor[source];
  const disclosure=useDisclosure(JSON.stringify([sessionId,initial.source,initial.recordId])),nodeIds=['metadata',...taskTreeDisclosureIds(row.children),...list(row.attempts).map((attempt:any,index:number)=>'attempt:'+(attempt.id??index))];
  return <Detail title="任务详情与子任务" onClose={onClose}><div className="hn-row hn-between"><h3>{row.title}</h3><span className="hn-board-status">{row.statusLabel??labels[row.status]??row.status}</span></div>
    {result.error?<ui.Band>详情刷新失败：{ui.errorText(result.error)}。下方为打开时的快照，请到原记录核对。</ui.Band>:result.loading&&!result.data?<p role="status">正在独立读取最新任务状态…</p>:result.data&&!result.data.items?.length?<ui.Band>原任务记录已归档或不再可用。下方为打开时的快照，不代表当前状态。</ui.Band>:<p className="hn-board-caption">详情独立刷新，不受列表筛选或分页影响。</p>}
    <p className="hn-note">{sources[source]??source}{origin(row)?' · '+origin(row):''}</p><p>{row.summary}</p>
    {row.reason?<ui.Band>当前原因：{ui.errorText(text(row.reason))}</ui.Band>:null}
    <div className="hn-row hn-disclosure-tools"><Button onClick={()=>disclosure.setAll(nodeIds,true)}>展开全部节点</Button><Button onClick={()=>disclosure.setAll(nodeIds,false)}>收起全部节点</Button></div>
    <details className="hn-compact-node" open={disclosure.isOpen('metadata')} onToggle={event=>disclosure.setOpen('metadata',event.currentTarget.open)}><summary><DisclosureChevron/><strong>编号与时间</strong><span className="hn-board-count">更新 {time(row.updated)}</span></summary><div className="hn-compact-node-content"><dl className="hn-board-facts"><div><dt>记录编号</dt><dd className="hn-mono">{row.recordId??row.id}</dd></div><div><dt>创建时间</dt><dd>{time(row.created)}</dd></div><div><dt>更新时间</dt><dd>{time(row.updated)}</dd></div>{row.dueAt?<div><dt>计划时间</dt><dd>{time(row.dueAt)}</dd></div>:null}{row.progress?<div><dt>已完成步骤</dt><dd>{row.progress.completed} / {row.progress.total}</dd></div>:null}</dl></div></details>
    <section className="hn-group"><h4>执行结果</h4><ResultSummary {...{row,ui}}/></section>
    {row.usage?<p className="hn-note">模型请求 {row.usage.requests} 次 · 供应商报告 {Number(row.usage.reportedTokens??0).toLocaleString('zh-CN')} token{row.usage.unknownUsageRequests?' · '+row.usage.unknownUsageRequests+' 次用量不完整':''} · 保守准入量 {Number(row.usage.conservativeAdmission??0).toLocaleString('zh-CN')}</p>:null}
    {list(row.children).length?<section className="hn-task-detail-section"><h4>目标步骤 · {row.children.length} 步</h4><TaskTree rows={row.children} {...{ui,onTask,disclosure}}/></section>:null}
    {list(row.attempts).length?<section className="hn-task-detail-section"><h4>执行尝试 · {row.attempts.length} 次</h4>{row.attempts.map((a:any,i:number)=>{const node='attempt:'+(a.id??i);return <details className="hn-compact-node" key={a.id??i} open={disclosure.isOpen(node)} onToggle={event=>disclosure.setOpen(node,event.currentTarget.open)}><summary><DisclosureChevron/><strong>第 {i+1} 次 · {a.statusLabel??labels[a.status??a.state]??a.status??a.state}</strong><time>{time(a.started??a.created)}</time></summary><div className="hn-compact-node-content"><p>开始 {time(a.started??a.created)}{a.ended?' · 结束 '+time(a.ended):''}</p>{a.reason?<p>{ui.errorText(text(a.reason))}</p>:null}</div></details>;})}</section>:null}
    <div className="hn-row hn-dialog-actions">{taskId?<Button primary onClick={()=>onTask(taskId)}>查看任务经过</Button>:null}{source==='tool'?<Button primary onClick={()=>onTool(row.jobId??row.recordId)}>查看工具回执</Button>:null}{source==='action'?<Button primary onClick={()=>onAction(row.actionId??row.recordId)}>查看文件与审批</Button>:null}{row.goalId&&source!=='goal'?<Button onClick={()=>onSection('goals')}>管理关联目标</Button>:null}{destination?<Button onClick={()=>onSection(destination)}>前往{sources[source]}管理</Button>:null}{row.matterId?<Button onClick={()=>onSection('attention')}>查看关注事项</Button>:null}<Button onClick={()=>onSection('reflections')}>查看结果反思</Button></div>
    <p className="hn-board-caption">状态来自当前保留的实际记录。暂停、重试、验收及写入审批在对应管理页处理。</p>
  </Detail>;
}

export default function TaskBoard({api,s,busy,ui,onSection}:any){
  const {Button,Field,Input,Select,Empty,TaskDetail}=ui,[query,setQuery]=useState(''),[dates,setDates]=useState({from:'',to:''}),[filters,setFilters]=useState<any>({query:'',source:'all',group:'all',offset:0,limit:40}),[nonce,setNonce]=useState(0),[selected,setSelected]=useState<any>(null),[taskId,setTaskId]=useState(''),[toolId,setToolId]=useState(''),[actionId,setActionId]=useState('');
  const [view,setView]=useState<'list'|'board'>('list'),disclosure=useDisclosure(JSON.stringify([s.sessionId,filters]));
  useEffect(()=>{const timer=setTimeout(()=>setFilters(old=>old.query===query.trim()?old:{...old,query:query.trim(),offset:0}),300);return ()=>clearTimeout(timer);},[query]);
  const result=useTaskBoard(api,s.sessionId,filters,nonce),data=result.data,rows=list(data?.items),counts=data?.counts??{};
  const columns=useMemo(()=>groups.map(([id,title])=>({id,title,rows:rows.filter((r:any)=>r.group===id)})).filter(column=>filters.group==='all'?column.rows.length>0:column.id===filters.group),[rows,filters.group]);
  const filter=(key:string,value:string)=>setFilters(old=>({...old,[key]:value,offset:0}));
  const dateRangeInvalid=!!dates.from&&!!dates.to&&new Date(dates.from).valueOf()>new Date(dates.to).valueOf();
  const applyDates=()=>setFilters(old=>({...old,from:dates.from?new Date(dates.from).valueOf():undefined,to:dates.to?new Date(dates.to).valueOf():undefined,offset:0}));
  const advancedFilters=[filters.source!=='all'?sources[filters.source]??filters.source:'',filters.group!=='all'?groups.find(([id])=>id===filters.group)?.[1]??filters.group:'',filters.from!==undefined||filters.to!==undefined?'已限定更新时间':''].filter(Boolean);
  const openTask=(id:string)=>{setSelected(null);setTaskId(id);},navigate=(section:string)=>{setSelected(null);onSection(section);};
  return <section className="hn-task-board" aria-label="任务看板总览"><div className="hn-row hn-between"><p className="hn-note">先看任务进展，点开一行再看经过与结果。每 15 秒刷新。</p><Button disabled={result.loading} onClick={()=>setNonce(n=>n+1)}>{result.loading?'正在刷新…':'刷新任务'}</Button></div>
    <div className="hn-task-stats" aria-label="任务统计">{groups.map(([id,label])=><button type="button" key={id} aria-pressed={filters.group===id} onClick={()=>filter('group',filters.group===id?'all':id)}><span>{label}</span><strong>{counts[id]??'—'}</strong></button>)}</div>
    <div className="hn-task-search"><Field label="搜索任务"><Input type="search" value={query} maxLength={160} onChange={setQuery} placeholder="任务名称、原因或编号"/></Field></div>
    <details className="hn-task-more-filters"><summary><span>更多筛选</span><span className="hn-board-count">{advancedFilters.length?advancedFilters.length+' 项生效 · '+advancedFilters.join(' · '):'类型、状态与时间'}</span></summary><div className="hn-fields"><Field label="任务类型"><Select value={filters.source} options={[["all","全部类型"],...Object.entries(sources)]} onChange={(v:string)=>filter('source',v)}/></Field><Field label="任务状态"><Select value={filters.group} options={[["all","全部状态"],...groups]} onChange={(v:string)=>filter('group',v)}/></Field><Field label="更新时间 · 从本地时间"><Input type="datetime-local" value={dates.from} onChange={(v:string)=>setDates(old=>({...old,from:v}))}/></Field><Field label="更新时间 · 至本地时间"><Input type="datetime-local" value={dates.to} onChange={(v:string)=>setDates(old=>({...old,to:v}))}/></Field></div>{dateRangeInvalid?<p role="alert">结束时间不能早于开始时间。</p>:null}<div className="hn-row"><Button disabled={dateRangeInvalid} onClick={applyDates}>应用时间范围</Button><Button onClick={()=>{setDates({from:'',to:''});setFilters(old=>({...old,from:undefined,to:undefined,offset:0}));}}>清除时间范围</Button><Button onClick={()=>{setDates({from:'',to:''});setFilters(old=>({...old,source:'all',group:'all',from:undefined,to:undefined,offset:0}));}}>重置更多筛选</Button></div></details>
    {result.error?<div className="hn-notice hn-error" role="alert">{ui.errorText(result.error)}{data?' · 当前保留上次结果，请刷新后核对。':''}</div>:null}
    <p className="hn-board-caption">统计为当前保留的顶层记录，子任务不重复计数；执行完成与目标验收分别记录。</p>
    {result.loading&&!data?<Empty>正在读取任务…</Empty>:!data?<Empty>暂时无法取得任务列表，请刷新。</Empty>:<>
      <div className="hn-row hn-between"><p className="hn-board-count" role="status">筛选结果 {data.total} 项 · 本页 {rows.length} 项</p><div className="hn-row"><Button disabled={filters.offset===0||result.loading} onClick={()=>setFilters(old=>({...old,offset:Math.max(0,old.offset-old.limit)}))}>上一页</Button><span className="hn-board-count">第 {Math.floor(filters.offset/filters.limit)+1} 页</span><Button disabled={!data.hasMore||result.loading} onClick={()=>setFilters(old=>({...old,offset:old.offset+old.limit}))}>下一页</Button></div></div>
      <div className="hn-task-view-tools"><div className="hn-task-view-switch" role="group" aria-label="任务呈现方式"><button type="button" aria-pressed={view==='list'} onClick={()=>setView('list')}>简洁列表</button><button type="button" aria-pressed={view==='board'} onClick={()=>setView('board')}>分栏看板</button></div>{view==='list'?<div className="hn-row"><Button disabled={!rows.length} onClick={()=>disclosure.setAll(rows.map((row:any)=>row.id),true)}>展开本页全部</Button><Button disabled={!rows.length} onClick={()=>disclosure.setAll(rows.map((row:any)=>row.id),false)}>收起全部</Button></div>:null}</div>
      {!rows.length?<Empty>没有匹配任务。可调整筛选，或从“目标”“定时任务”“工具与能力”创建任务。</Empty>:view==='list'?<ol className="hn-task-compact-list" aria-label="简洁任务列表">{rows.map((row:any)=><li key={row.id}><details className="hn-task-list-record" open={disclosure.isOpen(row.id)} onToggle={event=>disclosure.setOpen(row.id,event.currentTarget.open)}><summary><DisclosureChevron/><time>{time(row.updated)}</time><span className="hn-task-list-title"><strong>{row.title}</strong><span>{row.progress?'步骤 '+row.progress.completed+' / '+row.progress.total:row.usage?.requests?row.usage.requests+' 次模型请求':row.source==='schedule'?row.result?.mode==='prompt'?'定时执行':'定时提醒':row.source==='action'?'文件行动':'独立任务'}</span></span><span className="hn-task-list-source">{sources[row.source]??row.source}</span><span className="hn-board-status" data-tone={row.group==='attention'?'warning':row.group==='done'?'muted':undefined}>{row.statusLabel??labels[row.status]??row.status}</span></summary><div className="hn-task-list-content">{row.summary?<p>{row.summary}</p>:null}{row.reason?<p className="hn-note">当前原因：{ui.errorText(text(row.reason))}</p>:null}{row.source==='goal'&&row.result?.executionComplete?<p className="hn-note">目标验收：{row.result.achieved?'已符合配置规则':'仍需核对或补充证据'}</p>:null}<div className="hn-row"><Button onClick={()=>setSelected(row)}>查看步骤与结果</Button>{row.source==='autonomy'?<Button onClick={()=>openTask(row.taskId??row.recordId)}>查看执行经过</Button>:null}{sectionFor[row.source]?<Button onClick={()=>navigate(sectionFor[row.source])}>前往管理</Button>:null}</div></div></details></li>)}</ol>:<div className="hn-board-columns hn-task-columns">{columns.filter(column=>filters.group==='all'||column.id===filters.group).map(column=><section className="hn-board-column" key={column.id} aria-label={column.title+'任务'}><header><h3>{column.title}</h3><span className="hn-board-count">本页 {column.rows.length}</span></header>{!column.rows.length?<Empty>本页暂无</Empty>:column.rows.map((row:any)=><article className="hn-board-card" key={row.id}><div className="hn-board-tags"><span className="hn-board-tag">{sources[row.source]??row.source}</span><span className="hn-board-status" data-tone={row.group==='attention'?'warning':row.group==='done'?'muted':undefined}>{row.statusLabel??labels[row.status]??row.status}</span></div><h4>{row.title}</h4>{row.summary?<p className="hn-task-card-summary">{row.summary}</p>:null}{row.reason?<p className="hn-task-card-summary">{ui.errorText(text(row.reason))}</p>:null}{row.progress?<p>步骤 {row.progress.completed} / {row.progress.total}</p>:null}{row.source==='goal'&&row.result?.executionComplete?<p>验收：{row.result.achieved?'规则已满足':'尚未达成'}</p>:null}<p className="hn-board-caption">更新 {time(row.updated)}</p><div className="hn-row"><Button onClick={()=>setSelected(row)}>查看步骤与结果</Button>{sectionFor[row.source]?<Button onClick={()=>navigate(sectionFor[row.source])}>管理</Button>:null}</div></article>)}</section>)}</div>}
      <p className="hn-board-caption">{text(data.scope)||'仅展示当前数据库保留记录；已清理的历史不包含在统计中。'}{data.updatedAt?' · 读取 '+time(data.updatedAt):''}</p>
      {data.notes?.warnings?.length?<p className="hn-board-caption" role="status">部分记录源当前不可用，列表可能不完整：{data.notes.warnings.map((w:any)=>sources[w.source]??w.source).join('、')}。</p>:null}
    </>}
    {selected?<BoardDetail row={selected} api={api} sessionId={s.sessionId} ui={ui} onClose={()=>setSelected(null)} onTask={openTask} onSection={navigate} onTool={(id:string)=>{setSelected(null);setToolId(id);}} onAction={(id:string)=>{setSelected(null);setActionId(id);}}/>:null}
    {taskId?<TaskDetail api={api} id={taskId} onSection={navigate} onClose={()=>setTaskId('')}/>:null}
    {toolId?<ToolJobDetail api={api} id={toolId} busy={busy} ui={ui} nonce={nonce} onChanged={()=>setNonce(n=>n+1)} onClose={()=>setToolId('')}/>:null}
    {actionId?<ActionDetail api={api} id={actionId} ui={ui} onChanged={()=>setNonce(n=>n+1)} onClose={()=>setActionId('')}/>:null}
  </section>;
}
