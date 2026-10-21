import React,{useMemo,useState} from 'react';

const types=[['','全部类型'],['wake','唤醒与等待'],['task','任务'],['action','行动与文件'],['model','模型请求'],['learning','记忆与学习'],['delivery','手机投递'],['message','消息'],['skill','技能'],['configuration','设置与授权'],['system','系统']];
const typeNames:Record<string,string>=Object.fromEntries(types);
const statuses:Record<string,string>={success:'已完成',running:'进行中',wait:'等待中',suspended:'已保留进度',failed:'需要处理',unknown:'结果待确认',completed:'已完成',selected:'已选择方向',executed:'已完成分析',generated:'已生成',cancelled:'已停止',paused:'已暂停',blocked:'等待处理',expired:'已到期',proposed:'等待确认',approved:'已批准',active:'进行中','evidence-insufficient':'证据不足','validation-rejected':'结果未通过校验','needs-evidence':'需要补充证据','awaiting-review':'等待验收'};
const lanes:Record<string,string>={selection:'选择问题',executor:'子任务分析',foreground:'与你交流',autonomous:'自主执行',reminder:'准备提醒',scheduled:'定时任务',action:'行动与文件',tool:'工具执行'};
const eventNames:Record<string,string>={
  'timer-wake':'到达检查时间','brain-wait':'检查后选择等待','task-created':'创建一项任务','direction-selected':'确定当前方向','task-ready':'任务已就绪','task-executing':'开始推进任务','task-suspended':'保存任务进度','task-completed':'任务已完成','task-failed':'任务需要处理','task-cancelled':'本次任务已结束',
  'context-assembled':'整理现状与相关记忆','context-input-blocked':'本轮上下文超出预算','dispatch':'发起模型请求','attempt-selected':'完成方向选择','attempt-executed':'完成任务分析','attempt-completed':'模型请求已完成','attempt-generated':'回复已生成','attempt-failed':'模型请求未完成','attempt-cancelled':'停止当前请求','attempt-validation-rejected':'输出未通过校验','attempt-evidence-insufficient':'资料不足以支持结论',
  'research-searched':'取得公开搜索结果','research-query-step':'完成一轮资料搜索','research-read-step':'记录一次来源阅读','research-read-failed':'来源阅读未完成','source-fetched':'取得可阅读的资料','source-fetch-failed':'本次未能读取来源','research-unavailable':'本次没有取得可用资料',
  'learning-committed':'保存学习笔记','learning-remembered':'将学习结果记入记忆','learning-rejected':'学习结果未通过校验','learning-evidence-insufficient':'证据不足，未保存结论','learning-share-queued':'将学习发现加入分享队列','memory-saved':'保留一条记忆','memory-revised':'更新记忆内容','memory-forgotten':'遗忘指定记忆','note-revised':'更新笔记批注',
  'autonomy-deferred':'等待下一个合适时机','autonomy-plan-invalidated':'根据新信息调整方向','autonomy-turn-ended':'本轮自主执行已结束','social-contact-committed':'保留本轮交流记录','social-publication-deferred':'发送时机变化，暂不打扰','response-published':'在会话中发出回复','owner-command-recorded':'处理你的本地指令',
  'goal-proposed':'提出一个目标建议','goal-activate':'目标已激活','goal-progress':'更新目标进度','goal-completed':'目标已完成','goal-blocked':'目标推进需要处理','goal-pause':'目标已暂停','goal-cancel':'目标已取消','goal-needs-evidence':'目标还需要补充证据','goal-awaiting-review':'目标等待验收','goal-report-prepared':'整理好报告草稿',
  'action-proposed':'准备好待批准的行动','action-approved':'收到单次行动批准','action-executing':'执行已批准的行动','action-completed':'取得行动完成回执','action-blocked':'行动等待处理','action-cancelled':'行动已取消','action-expired':'行动授权已到期','action-notified':'在会话中告知行动结果',
  'schedule-executing':'执行到期的定时任务','schedule-delivered':'定时结果已写入会话','schedule-blocked':'定时任务等待处理','reminder-created':'记录一条提醒','reminder-committed':'提醒已写入会话','skill-saved':'保存技能设置','skill-toggled':'调整技能启用状态','skill-rollback':'恢复技能历史版本','development-input-excluded':'开发输入未写入真实长期记忆',
};
const emptyFilters=()=>({type:'',status:'',origin:'',lane:'',taskId:'',query:'',from:'',to:''});
const format=(ui:any,value:any)=>typeof ui.formatTime==='function'?ui.formatTime(value):typeof ui.time==='function'?ui.time(value):value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const count=(ui:any,value:any)=>ui.num?ui.num(value??0):Number(value??0).toLocaleString('zh-CN');
const title=(event:any)=>eventNames[event.kind]??eventNames[event.title]??(/[\u4e00-\u9fff]/u.test(event.title??'')?event.title:(typeNames[event.type]??'系统')+'记录');
function originName(value:string,s:any){
  const names:Record<string,string>={owner:'主人输入',timer:'定时触发',system:'系统',web:'网页',mobile:'手机',local:'本地',runtime:'运行模块'};
  if(names[value])return names[value];
  const paired=(s.im?.paired??[]).find((item:any)=>item.id===value),channels:Record<string,string>={weixin:'微信',telegram:'Telegram',feishu:'飞书',dingtalk:'钉钉',qq:'QQ',wecom:'企业微信'};
  return paired?channels[paired.platform]??'远程渠道':value?.startsWith('im-')?'远程渠道':'其他来源';
}
function safeFields(value:any,depth=0):any{
  if(depth>8)return '[已折叠过深字段]';
  if(typeof value==='string')return value.replace(/([?&](?:token|api_key|access_token)=)[^\s&]+/gi,'$1[已隐藏]').replace(/sk-[\w-]{16,}/g,'[已隐藏]');
  if(Array.isArray(value))return value.map(item=>safeFields(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['reasoning','reasoningtext','reasoningcontent','analysis','analysistext','chainofthought','chainofthoughttext','thought','thoughts','thinking','thoughtprocess','internalreasoning','rawresponse','rawcompletion','rawoutput','messages','systemprompt','apikey','token','password','authorization','headers'].includes(key.toLowerCase().replace(/[_-]/g,''))).map(([key,item])=>[key,safeFields(item,depth+1)]));
  return value;
}

export default function EventLog({api,s,ui}:any){
  const {Button,Field,Input,Select,Band,Empty,ReadState,useRead,TaskDetail,JsonDetails}=ui;
  const [filters,setFilters]=useState(emptyFilters),[draft,setDraft]=useState(emptyFilters),[cursors,setCursors]=useState<any[]>([{}]),[nonce,setNonce]=useState(0),[view,setView]=useState<'timeline'|'tasks'>('timeline'),[task,setTask]=useState(''),[error,setError]=useState('');
  const input={kind:'activity',limit:25,...filters,...cursors.at(-1),from:filters.from?new Date(filters.from).getTime():undefined,to:filters.to?new Date(filters.to).getTime():undefined};
  const result=useRead(api,input,nonce),applied=Object.values(filters).filter(Boolean).length;
  const groups=useMemo(()=>{
    const grouped=new Map<string,any[]>();for(const event of result.data?.items??[]){const key=event.taskId??'';if(!grouped.has(key))grouped.set(key,[]);grouped.get(key)!.push(event);}return [...grouped.entries()];
  },[result.data]);
  const patch=(key:string,value:string)=>setDraft(previous=>({...previous,[key]:value}));
  function apply(){
    const from=draft.from?new Date(draft.from).getTime():null,to=draft.to?new Date(draft.to).getTime():null;
    if(from!==null&&!Number.isFinite(from)||to!==null&&!Number.isFinite(to)||from!==null&&to!==null&&from>to){setError('请检查开始与结束时间，结束时间不能早于开始时间。');return;}
    setError('');setFilters({...draft});setCursors([{}]);setNonce(value=>value+1);
  }
  function reset(){setError('');setDraft(emptyFilters());setFilters(emptyFilters());setCursors([{}]);setNonce(value=>value+1);}
  const exportPage=()=>{if(result.data)ui.download({...result.data,items:result.data.items.map((event:any)=>({...event,data:safeFields(event.data)}))},'human-events-page.json');};
  const renderEvent=(event:any)=><article className="hn-activity-event" key={event.id}>
    <span className="hn-activity-event-dot" data-status={event.status} aria-hidden="true"/>
    <div className="hn-activity-event-body"><div className="hn-activity-event-top"><strong>{title(event)}</strong><time>{format(ui,event.time)}</time></div>
      <p className="hn-activity-event-meta"><span>{typeNames[event.type]??'其他事件'}</span><span data-status={event.status}>{statuses[event.status]??'已记录'}</span><span>{originName(event.origin,s)}</span>{event.lane?<span>{lanes[event.lane]??'其他阶段'}</span>:null}</p>
      <div className="hn-activity-event-links">{event.taskId?<button type="button" className="hn-link" onClick={()=>setTask(event.taskId)}>查看关联任务 <span aria-hidden="true">↗</span></button>:null}<JsonDetails value={safeFields({eventId:event.id,eventKind:event.kind,type:event.type,status:event.status,origin:event.origin,lane:event.lane,taskId:event.taskId,requestId:event.requestId,roundId:event.roundId,data:event.data})} label="原始字段与关联标识"/></div>
    </div>
  </article>;
  return <div className="hn-activity-events">
    <div className="hn-activity-toolbar"><p>按时间查看执行记录，或沿着一个任务追溯每一步。</p><div className="hn-activity-toolbar-actions"><Button disabled={result.loading} onClick={()=>setNonce(value=>value+1)}>刷新</Button><Button disabled={!result.data} onClick={exportPage}>导出本页</Button></div></div>
    <div className="hn-activity-log-tools"><div className="hn-activity-view-switch" role="group" aria-label="事件排列方式"><button type="button" aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>按时间</button><button type="button" aria-pressed={view==='tasks'} onClick={()=>setView('tasks')}>按任务</button></div><span className="hn-activity-caption">每页 25 条</span></div>
    <details className="hn-activity-filters"><summary>高级筛选{applied?<span className="hn-activity-filter-count">{applied} 项已应用</span>:null}</summary>
      <form className="hn-activity-filter-grid" onSubmit={event=>{event.preventDefault();apply();}}>
        <Field label="开始时间"><Input type="datetime-local" value={draft.from} onChange={(value:string)=>patch('from',value)}/></Field><Field label="结束时间"><Input type="datetime-local" value={draft.to} onChange={(value:string)=>patch('to',value)}/></Field>
        <Field label="事件类型"><Select value={draft.type} options={types} onChange={(value:string)=>patch('type',value)}/></Field><Field label="状态"><Select value={draft.status} options={[['','全部状态'],['success','已完成'],['running','进行中'],['wait','等待中'],['suspended','已保留进度'],['failed','需要处理'],['unknown','结果待确认']]} onChange={(value:string)=>patch('status',value)}/></Field>
        <Field label="触发来源" hint="可填写来源名称或已知的渠道标识。"><Input value={draft.origin} maxLength={100} placeholder="例如 timer 或 owner" onChange={(value:string)=>patch('origin',value)}/></Field><Field label="执行阶段"><Select value={draft.lane} options={[["","全部阶段"],...Object.entries(lanes)]} onChange={(value:string)=>patch('lane',value)}/></Field>
        <Field label="关联任务标识"><Input value={draft.taskId} maxLength={100} placeholder="粘贴任务标识" onChange={(value:string)=>patch('taskId',value)}/></Field><Field label="关键词"><Input value={draft.query} maxLength={160} placeholder="查找事件或字段" onChange={(value:string)=>patch('query',value)}/></Field>
        <div className="hn-activity-filter-actions"><Button primary onClick={apply}>应用筛选</Button><Button onClick={reset}>清空筛选</Button></div>
      </form>
    </details>
    {error?<p className="hn-activity-validation" role="alert">{error}</p>:null}
    <ReadState result={result}>{(data:any)=><>
      <p className="hn-activity-result-caption">共 {count(ui,data.total)} 条记录 · 第 {cursors.length} 页{view==='tasks'?' · 以下任务仅归组本页事件':''}</p>
      {!data.items.length?<Empty>这个范围内还没有符合条件的事件。可以调整筛选后再看看。</Empty>:view==='timeline'?<div className="hn-activity-event-list">{data.items.map(renderEvent)}</div>:<div className="hn-activity-task-groups">{groups.map(([id,rows],index)=><section key={id||'independent'} className="hn-activity-task-group"><header><div><h3>{id?'关联任务 '+(index+1):'独立事件'}</h3><span>{rows.length} 条本页记录</span></div>{id?<Button onClick={()=>setTask(id)}>查看完整任务</Button>:null}</header><div className="hn-activity-event-list">{rows.map(renderEvent)}</div></section>)}</div>}
      <nav className="hn-activity-pagination" aria-label="事件日志分页"><Button disabled={cursors.length<2||result.loading} onClick={()=>setCursors(value=>value.slice(0,-1))}>上一页</Button><span>第 {cursors.length} 页</span><Button disabled={!data.hasMore||result.loading} onClick={()=>setCursors(value=>[...value,data.next])}>下一页</Button></nav>
      <details className="hn-activity-record-note"><summary>记录口径与追踪范围</summary><p>模型事件中的供应商报告用量与保守占额口径不同；手机发送回执也不代表已人工确认实收。追踪启用时间：{format(ui,data.tracingSince)}。导出仅包含当前筛选下的这一页事件。</p></details>
    </>}</ReadState>
    {task?<TaskDetail api={api} id={task} onClose={()=>setTask('')}/>:null}
  </div>;
}

export {EventLog};
