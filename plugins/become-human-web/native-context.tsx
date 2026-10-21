import React,{useState} from 'react';

const stages:any={selection:'方向选择',executor:'子任务执行',foreground:'主人聊天',scheduled:'定时模型任务'};
const fields:any={'domain.memories':'记忆','domain.goals':'目标',ownerEvidence:'主人原话',history:'聊天历史',recent:'近期消息',learningNotes:'学习笔记','social.topicMemory.topics':'长期话题','social.recentTopics':'近期话题'};
const time=(n:any)=>n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'尚无记录';

export default function ContextStatus({api,ui}:any){
  const {Button,Band,Empty,ReadState,useRead}=ui;
  const [nonce,setNonce]=useState(0),result=useRead(api,{kind:'context-status'},nonce);
  return <><div className="hn-row hn-between"><h3>每轮实际带入的上下文</h3><Button onClick={()=>setNonce(n=>n+1)}>刷新状态</Button></div>
    <Band>先检查事件和时机，再选择方向。人格只装入一份；当前状态每轮从有效记录重建；重要事实保留候选位置，其余记忆按关键词相关性与类型选择。原始资料保留在记忆库和学习笔记中，按任务取用。</Band>
    <ReadState result={result}>{(data:any)=><>
      {data.current?<section className="hn-group"><h3>当前状态摘要 · {time(data.current.at)}</h3>
        <p>最近有效用户消息：{time(data.current.owner.lastMessage?.at)}。当前情绪与身体状态需重新确认。</p>
        <p>{data.current.contact.quiet?'当前在静默时段':'当前不在静默时段'} · 最近主动联系：{time(data.current.contact.lastContact)}</p>
        <p>待继续任务 {data.current.pendingTaskCount} 项 · 待处理定时事项 {data.current.reminderCount} 项{data.current.authorization.awaitingExtraBudget?' · 正等待额外额度授权':''}</p>
        {data.current.currentTask&&<p>当前待继续任务：{data.current.currentTask.kind} · {data.current.currentTask.status}</p>}
        <details><summary>状态字段与任务编号</summary><pre className="hn-json">{JSON.stringify(data.current,null,2)}</pre></details>
      </section>:<Empty>运行模块连接后可读取当前状态摘要。</Empty>}
      {Object.entries(stages).map(([lane,label])=>{const r=data.last[lane];return <section className="hn-group" key={lane}><h3>{label as string}</h3>{!r?<p className="hn-note">新版尚未记录该阶段的模型上下文。</p>:<>
        <p>{time(r.time)} · 装入 {r.estimatedInput.toLocaleString()} / {r.budget.toLocaleString()} 预算单位</p>
        <p className="hn-note">固定必需内容 {r.required.toLocaleString()} 单位 · 装配前候选内容 {r.inputBytes.toLocaleString()} 单位</p>
        {Object.entries(fields).map(([key,name])=><p className="hn-note" key={key}>{name as string}：装入 {r.counts[key]??0} 条，因输入预算省略 {r.omitted[key]??0} 条</p>)}
        {r.importantFactsOmitted>0&&<Band>有 {r.importantFactsOmitted} 条重要事实候选未装入。可在“模型与执行”提高该阶段输入预算。</Band>}
        <details><summary>本轮记忆编号与版本</summary><pre className="hn-json">{JSON.stringify(r.memoryRefs,null,2)}</pre></details>
      </>}</section>;})}
      <Band>输入预算按实际序列化内容的 UTF-8 字节数加 256 单位封装预留计算，不是模型分词结果；供应商实际 token 见事件日志。固定指令、核心人格、当前输入、当前任务和执行所需来源不会被截断，必需内容超限时会停止该次调用并记录错误。历史摘录只作背景。该页为只读，不调用模型；“最近一轮”保留当时的编号与版本。</Band>
    </>}</ReadState>
  </>;
}
