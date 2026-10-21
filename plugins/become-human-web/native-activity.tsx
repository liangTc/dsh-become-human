import React,{useEffect,useState} from 'react';
import BrainTimeline from './native-timeline';
import EventLog from './native-events';
import css from './native-activity.css';

type ActivityMode='brain'|'events';
const normalize=(value:string):ActivityMode=>value==='activity'||value==='events'?'events':'brain';
const phases:Record<string,string>={idle:'待机',waiting:'等待合适时机',selecting:'选择问题',executing:'推进当前任务',checking:'检查待办', 'checking-source':'阅读来源',searching:'搜索资料','learned-without-notification':'已学习，暂不打扰','waiting-budget':'等待额度','waiting-approval':'等待批准','autonomy-error':'等待处理','collecting-input':'等你补充消息',preempted:'优先回应你的消息'};
const channels:Record<string,string>={weixin:'微信',telegram:'Telegram',feishu:'飞书',dingtalk:'钉钉',qq:'QQ',wecom:'企业微信',whatsapp:'WhatsApp',discord:'Discord',slack:'Slack',matrix:'Matrix'};

export default function ActivityPage({api,s,ui,initialMode='brain'}:any){
  const [mode,setMode]=useState<ActivityMode>(()=>normalize(initialMode));
  const [visited,setVisited]=useState(()=>({brain:normalize(initialMode)==='brain',events:normalize(initialMode)==='events'}));
  useEffect(()=>{const next=normalize(initialMode);setMode(next);setVisited(value=>value[next]?value:{...value,[next]:true});},[initialMode]);
  const select=(next:ActivityMode)=>{setMode(next);setVisited(value=>value[next]?value:{...value,[next]:true});};
  const paired=(s.im?.paired??[]).filter((item:any)=>item.enabled);
  const running=s.desired==='running',autonomy=s.autonomy;
  const state=!running?'已暂停':autonomy?.paused?'自主已暂停':s.agentBusy?'正在处理':'在线待机';
  const phase=phases[autonomy?.phase]??(s.agentBusy?'处理当前任务':'待机');
  return <section className="hn-activity" aria-label="活动记录">
    <style>{css}</style>
    <header className="hn-activity-heading">
      <div><h2>活动</h2><p>看看她最近关注了什么、做了什么，又留下了哪些记忆。</p></div>
      <span className="hn-activity-live"><span data-active={running&&!autonomy?.paused}/>{state}</span>
    </header>
    <div className="hn-activity-layout">
      <div className="hn-activity-main">
        <nav className="hn-activity-tabs" role="tablist" aria-label="活动查看方式" onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
          event.preventDefault();const next:ActivityMode=event.key==='Home'?'brain':event.key==='End'?'events':mode==='brain'?'events':'brain';select(next);
          event.currentTarget.querySelector<HTMLButtonElement>('[data-mode="'+next+'"]')?.focus();
        }}>
          {([['brain','大脑时间线'],['events','事件日志']] as const).map(([key,label])=><button key={key} id={'hn-activity-tab-'+key} type="button" role="tab" data-mode={key} aria-selected={mode===key} aria-controls={'hn-activity-panel-'+key} tabIndex={mode===key?0:-1} onClick={()=>select(key)}>{label}</button>)}
        </nav>
        <div id="hn-activity-panel-brain" className="hn-activity-panel" role="tabpanel" aria-labelledby="hn-activity-tab-brain" hidden={mode!=='brain'}>{visited.brain?<BrainTimeline api={api} s={s} ui={ui}/>:null}</div>
        <div id="hn-activity-panel-events" className="hn-activity-panel" role="tabpanel" aria-labelledby="hn-activity-tab-events" hidden={mode!=='events'}>{visited.events?<EventLog api={api} s={s} ui={ui}/>:null}</div>
      </div>
      <aside className="hn-activity-aside" aria-label="记录说明">
        <section><h3>此刻</h3><dl><div><dt>运行状态</dt><dd>{state}</dd></div><div><dt>当前活动</dt><dd>{phase}</dd></div><div><dt>已绑定渠道</dt><dd>{paired.length?paired.map((item:any)=>channels[item.platform]??'远程渠道').join('、'):'暂无绑定'}</dd></div></dl></section>
        <section><h3>{mode==='brain'?'把经过连起来看':'从记录追溯经过'}</h3><p>{mode==='brain'?'时间线按活动整理问题、执行经过和记忆。展开一段活动，可以继续查看关联任务。':'日志按时间保留事件，也可按关联任务归组。筛选与导出只使用当前查询范围。'}</p></section>
        <section className="hn-activity-evidence-note"><span aria-hidden="true">↳</span><p>这里展示已记录的方向、行动回执与来源记忆，不展示模型内部推理，也不代表未发生的现实行动。</p></section>
      </aside>
    </div>
  </section>;
}

export {ActivityPage};
