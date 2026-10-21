import React from 'react';

const reasons:Record<string,string>={
  'social-disabled':'主动闲聊未启用','autonomy-paused':'自主模式暂停中','quiet-hours':'静默时段',
  'awaiting-owner-reply':'已有多条主动消息未回复，等待你回应','contact-minimum-gap':'与上一条主动消息保持间隔',
  'social-cadence':'等待下一次闲聊时机','social-task-backoff':'本轮选择等待或结果未通过，稍后再看',
  'social-topics-cooling':'近期话题正在冷却',
};
const clock=(n:number|null)=>n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'等待条件变化';
const topicLabels:Record<string,string>={daily:'日常与时段',interests:'人格兴趣',connection:'关系互动','open-thread':'接续话题',curiosity:'好奇与观点',reflection:'生活与成长',care:'生活关心'};
const topic=(key:string)=>topicLabels[key]??(key?.startsWith('insight:')?'学习分享':'主动交流');

export default function SocialSettings({value:v,patch,status:s,ui}:any){
  const {Check,Field,Input,Band}=ui;
  return <section className="hn-group" aria-label="主动闲聊设置">
    <h3>主动闲聊与交流节奏</h3>
    <Check label="主动开启生活与兴趣话题" value={v.socialEnabled} onChange={(x:boolean)=>patch('socialEnabled',x)}/>
    <p className="hn-note">启用自主行为和主动联系后生效。闲聊无需新的用户消息或学习笔记；按人格、有效记忆、时段与最近话题选择是否开口，可以选择等待。与学习任务轮换执行。</p>
    <div className="hn-fields">
      {[
        ['socialIntervalMs','闲聊基础间隔 · 分钟',10,1440],
        ['socialMinGapMs','任意两条主动消息最小间隔 · 分钟',10,1440],
        ['socialTopicCooldownMs','同类话题冷却 · 分钟',10,10080],
      ].map(([key,label,min,max]:any)=><Field key={key} label={label}><Input type="number" min={min} max={max} value={v[key]/60000} onChange={(x:number)=>patch(key,Math.round(x*60000))}/></Field>)}
      <Field label="未回复时最多主动联系 · 条" hint="包括新版闲聊、关心和学习分享；定时提醒单独执行。"><Input type="number" min={1} max={8} value={v.socialMaxUnanswered} onChange={(x:number)=>patch('socialMaxUnanswered',x)}/></Field>
    </div>
    <p className="hn-note">未回复时闲聊间隔按 2 倍退避，上限 24 小时；达到连续未回复条数后等待你回应，新消息会重新计算。沿用上方静默时段。间隔是检查资格，实际是否发送由本轮判断决定；自主 token、请求与轮次额度仍统一计算。</p>
    {s&&<Band><strong>当前闲聊状态：{s.reason?reasons[s.reason]??s.reason:'已具备交流时机，等待本轮选择'}</strong>
      <p>连续未回复 {s.unanswered} / {s.maxUnanswered} 条 · 当前闲聊间隔 {Math.round(s.effectiveIntervalMs/60000)} 分钟</p>
      <p>最早可再次检查：{clock(s.nextEligibleAt)}</p>
      <p className="hn-note">最近话题：{s.recentTopics?.length?s.recentTopics.map((t:any)=>topic(t.topicKey)).join('、'):'暂无新版主动交流记录'}</p>
    </Band>}
  </section>;
}
