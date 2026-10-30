import React,{useEffect,useState} from 'react';
import BrainTimeline from './native-timeline';
import EventLog from './native-events';
import css from './native-activity.css';
const modes=[['brain','时间线'],['events','事件记录'],['runtime','运行诊断'],['delivery','手机投递']];
const normalize=(value:string)=>modes.some(([key])=>key===value)?value:value==='activity'?'events':'brain';
export default function ActivityPage({api,s,ui,initialMode='brain',renderRuntime,renderDelivery}:any){
  const [mode,setMode]=useState(()=>normalize(initialMode));
  const [visited,setVisited]=useState<Record<string,boolean>>(()=>({[normalize(initialMode)]:true}));
  const select=(next:string)=>{setMode(next);setVisited(value=>({...value,[next]:true}));};
  useEffect(()=>select(normalize(initialMode)),[initialMode]);
  const bodies:any={brain:()=> <BrainTimeline {...{api,s,ui}}/>,events:()=> <EventLog {...{api,s,ui}}/>,runtime:renderRuntime,delivery:renderDelivery};
  return <section className="hn-activity hn-logs" aria-label="日志">
    <style>{css}</style><header className="hn-activity-heading"><div><h2>日志</h2><p>查看发生过什么，需要时再展开详情。</p></div></header>
    <nav className="hn-activity-tabs" role="tablist" aria-label="日志分类" onKeyDown={event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const index=modes.findIndex(([key])=>key===mode),next=modes[event.key==='Home'?0:event.key==='End'?modes.length-1:(index+(event.key==='ArrowLeft'?-1:1)+modes.length)%modes.length][0];select(next);
      event.currentTarget.querySelector<HTMLButtonElement>('[data-mode="'+next+'"]')?.focus();
    }}>{modes.map(([key,label])=><button key={key} type="button" role="tab" id={'hn-log-tab-'+key} data-mode={key} aria-selected={mode===key} aria-controls={'hn-log-panel-'+key} tabIndex={mode===key?0:-1} onClick={()=>select(key)}>{label}</button>)}</nav>
    {modes.map(([key])=><div key={key} className="hn-activity-panel" role="tabpanel" id={'hn-log-panel-'+key} aria-labelledby={'hn-log-tab-'+key} hidden={mode!==key}>{visited[key]&&bodies[key]?.()}</div>)}
  </section>;
}
export {ActivityPage};
