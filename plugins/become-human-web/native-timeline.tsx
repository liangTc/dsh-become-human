import React,{useState} from 'react';
import {DisclosureChevron,useDisclosure,useRetainedRead} from './native-disclosure';

const categories:Record<string,string>={action:'行动与产物',autonomous:'自主活动',chat:'与你交流',memory:'记忆整理',schedule:'定时任务',check:'等待与检查'};
const statuses:Record<string,string>={success:'已完成',running:'进行中',wait:'暂时等待',suspended:'已保留进度',failed:'需要处理'};
function format(ui:any,value:number,part?:'time'|'date'){
  if(typeof ui.formatTime==='function')return ui.formatTime(value,part);
  if(typeof ui.time==='function')return ui.time(value);
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '—';
  return part==='time'?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):part==='date'?date.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}):date.toLocaleString('zh-CN',{hour12:false});
}
const count=(ui:any,value:any)=>ui.num?ui.num(value??0):Number(value??0).toLocaleString('zh-CN');
function localInput(ms:number){const date=new Date(ms);return new Date(ms-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}

export default function BrainTimeline({api,s,ui}:any){
  const {Button,Field,Input,Select,Band,Empty,ReadState,TaskDetail,ActionDetail,JsonDetails}=ui;
  const offset=s.autonomy?.settings?.timeZoneOffsetMinutes??480;
  const [range,setRange]=useState(()=>{const now=Date.now(),from=Math.floor((now+offset*60000)/86400000)*86400000-offset*60000;return {from,to:now};});
  const [filter,setFilter]=useState({category:'',status:'',query:''});
  const [draft,setDraft]=useState(()=>({...filter,from:localInput(range.from),to:localInput(range.to)}));
  const [cursors,setCursors]=useState<any[]>([{}]),[nonce,setNonce]=useState(0),[task,setTask]=useState(''),[action,setAction]=useState(''),[pageScope,setPageScope]=useState(0),[error,setError]=useState('');
  const scope=JSON.stringify([s.sessionId,pageScope]),disclosure=useDisclosure(scope),result=useRetainedRead(api,{kind:'brain-timeline',...range,...filter,...cursors.at(-1),limit:15},nonce,scope);
  const patch=(key:string,value:string)=>setDraft(previous=>({...previous,[key]:value}));
  function preset(days:number){
    const now=Date.now(),from=days===0?Math.floor((now+offset*60000)/86400000)*86400000-offset*60000:now-days*86400000;
    setError('');setRange({from,to:now});setDraft(previous=>({...previous,from:localInput(from),to:localInput(now)}));setCursors([{}]);setPageScope(value=>value+1);setNonce(value=>value+1);
  }
  function apply(){
    const from=new Date(draft.from).getTime(),to=new Date(draft.to).getTime();
    if(!Number.isFinite(from)||!Number.isFinite(to)||from>to||to-from>31*86400000){setError('请选择有效的起止时间，每次最多查看 31 天。');return;}
    setError('');setRange({from,to});setFilter({category:draft.category,status:draft.status,query:draft.query});setCursors([{}]);setPageScope(value=>value+1);setNonce(value=>value+1);
  }
  function refresh(){const now=Date.now();setRange(previous=>({...previous,to:now}));setDraft(previous=>({...previous,to:localInput(now)}));setCursors([{}]);if(cursors.length>1)setPageScope(value=>value+1);setNonce(value=>value+1);}
  const activeFilters=Object.values(filter).filter(Boolean).length;
  return <div className="hn-activity-brain">
    <div className="hn-activity-toolbar"><p>沿着时间，回顾一段活动的起点、经过与结果。</p><div className="hn-activity-toolbar-actions"><Button disabled={result.loading} onClick={refresh}>刷新</Button><Button disabled={!result.data} onClick={()=>{if(result.data)ui.download(result.data,'human-timeline.json');}}>导出本页</Button></div></div>
    <div className="hn-activity-range-tools"><div className="hn-activity-range-buttons" role="group" aria-label="快速选择时间"><button type="button" onClick={()=>preset(0)}>今天</button><button type="button" onClick={()=>preset(1)}>最近 24 小时</button><button type="button" onClick={()=>preset(7)}>最近 7 天</button></div><span className="hn-activity-caption">每页 15 段活动</span></div>
    <details className="hn-activity-filters"><summary>筛选时间与活动{activeFilters?<span className="hn-activity-filter-count">{activeFilters} 项已应用</span>:null}</summary><form className="hn-activity-filter-grid" onSubmit={event=>{event.preventDefault();apply();}}>
      <Field label="开始时间"><Input type="datetime-local" value={draft.from} onChange={(value:string)=>patch('from',value)}/></Field><Field label="结束时间"><Input type="datetime-local" value={draft.to} onChange={(value:string)=>patch('to',value)}/></Field>
      <Field label="活动类别"><Select value={draft.category} onChange={(value:string)=>patch('category',value)} options={[["","全部活动"],...Object.entries(categories)]}/></Field><Field label="进展状态"><Select value={draft.status} onChange={(value:string)=>patch('status',value)} options={[["","全部进展"],...Object.entries(statuses)]}/></Field>
      <Field label="话题或记忆关键词"><Input value={draft.query} maxLength={160} placeholder="查找关注的问题或留下的记忆" onChange={(value:string)=>patch('query',value)}/></Field><div className="hn-activity-filter-actions"><Button primary onClick={apply}>查看这段时间</Button></div>
    </form></details>
    {error?<p className="hn-activity-validation" role="alert">{error}</p>:null}
    {result.error&&result.data?<Band>刷新失败：{ui.errorText(result.error)}。当前保留上次读取记录。</Band>:null}
    <ReadState result={{...result,loading:result.loading&&!result.data,error:result.data?'':result.error}}>{(data:any)=><>
      <div className="hn-activity-metrics" aria-label="当前时间范围汇总">{[['关注的问题',data.totals.questions],['完成的活动',data.totals.actions],['留下的记忆',data.totals.memories],['选择等待',data.totals.waits]].map(([label,value])=><div key={label}><span>{label}</span><strong>{count(ui,value)}</strong></div>)}</div>
      <p className="hn-activity-result-caption">{format(ui,data.from)} — {format(ui,data.to)}<span>共 {count(ui,data.total)} 段活动</span></p>
      <div className="hn-disclosure-tools hn-row hn-between"><span className="hn-board-caption">点开一段活动，查看关注的问题、行动与记忆。</span><div className="hn-row"><Button disabled={!data.items.length} onClick={()=>disclosure.setAll(data.items.map((item:any)=>item.id),true)}>展开本页全部</Button><Button disabled={!data.items.length} onClick={()=>disclosure.setAll(data.items.map((item:any)=>item.id),false)}>收起全部</Button></div></div>
      {data.partial?<Band>这个范围内记录较多，当前汇总有数量上限。缩小时间范围，可以查看更完整的经过。</Band>:null}
      {!data.items.length?<Empty>这段时间还没有符合条件的活动。试试调整时间范围。</Empty>:<ol className="hn-activity-brain-stream">{data.items.map((item:any)=>{
        const open=disclosure.isOpen(item.id),actions=item.actions??[],memories=item.memories??[];
        const renderStep=(step:any,stepIndex:number)=><li key={step.id??stepIndex}><time>{format(ui,step.time,'time')}</time><div><span>{step.label}</span>{step.detail?<p>{step.detail}</p>:null}</div></li>;
        return <li className="hn-activity-brain-entry" key={item.id}>
          <div className="hn-activity-time-rail"><time>{format(ui,item.ended,'time')}</time><span>{format(ui,item.started,'date')}</span><i data-status={item.status} aria-hidden="true"/></div>
          <details className="hn-activity-brain-record" open={open} onToggle={event=>{
            disclosure.setOpen(item.id,event.currentTarget.open);
          }}>
            <summary><span className="hn-activity-record-label"><span className="hn-activity-kind">{categories[item.kind]??'活动记录'}</span><strong>{item.title}</strong></span><span className="hn-activity-record-end"><span className="hn-activity-status" data-status={item.status}>{statuses[item.status]??'已记录'}</span><DisclosureChevron/></span></summary>
            <div className="hn-activity-record-content">
              <div className="hn-activity-brain-detail-grid">
                <section className="hn-activity-question"><h3>关注的问题</h3><p>{item.question}</p>{item.value?<details className="hn-activity-direction"><summary>为什么关注这件事</summary><p>{item.value}</p></details>:null}</section>
                <section><h3>做了什么</h3>{actions.length?<ol className="hn-activity-steps">{actions.slice(-4).map(renderStep)}</ol>:<p className="hn-activity-muted">没有额外行动记录。</p>}{actions.length>4?<details className="hn-activity-more-steps"><summary>查看完整经过 · {actions.length} 步</summary><ol className="hn-activity-steps">{actions.map(renderStep)}</ol></details>:null}</section>
                <section><h3>记住了什么</h3>{memories.length?memories.map((memory:any)=><div key={memory.id} className="hn-activity-memory"><strong>{memory.title}</strong><p>{memory.description}</p><small>{memory.truth==='inferred'?'来自资料的解释，仍可纠正':memory.truth==='fictional'?'角色虚构内容':'有来源的记录'} · {memory.status==='active'?'当前保留':'状态已变化'}</small></div>):<p className="hn-activity-muted">这段活动没有新增记忆。</p>}</section>
              </div>
              <footer className="hn-activity-record-footer"><span>{item.requests?count(ui,item.requests)+' 次模型请求 · '+count(ui,item.reportedTokens)+' 供应商报告 token':'没有模型请求记录'}</span><div>{item.taskId?<button type="button" className="hn-link" onClick={()=>setTask(item.taskId)}>追溯完整任务 <span aria-hidden="true">↗</span></button>:null}{item.actionId?<button type="button" className="hn-link" onClick={()=>setAction(item.actionId)}>查看行动与文件 <span aria-hidden="true">↗</span></button>:null}</div></footer>
              {JsonDetails?<div className="hn-activity-record-ids"><JsonDetails value={{activityId:item.id,taskId:item.taskId??null,actionId:item.actionId??null,noteIds:item.noteIds??[],started:item.started,ended:item.ended}} label="记录标识与时间"/></div>:null}
            </div>
          </details>
        </li>;
      })}</ol>}
      <nav className="hn-activity-pagination" aria-label="大脑时间线分页"><Button disabled={cursors.length<2||result.loading} onClick={()=>{setCursors(value=>value.slice(0,-1));setPageScope(value=>value+1);}}>上一页</Button><span>第 {cursors.length} 页</span><Button disabled={!data.hasMore||result.loading} onClick={()=>{setCursors(value=>[...value,data.next]);setPageScope(value=>value+1);}}>下一页</Button></nav>
      <p className="hn-activity-bottom-note">仅显示明确记录的问题与方向、执行回执和记忆。需要逐条核对时，可切换到事件日志。</p>
    </>}</ReadState>
    {task?<TaskDetail api={api} id={task} onClose={()=>setTask('')}/>:null}{action&&ActionDetail?<ActionDetail api={api} id={action} ui={ui} onClose={()=>setAction('')}/>:null}
  </div>;
}

export {BrainTimeline};
