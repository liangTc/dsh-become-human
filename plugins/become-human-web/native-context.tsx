import React,{useState} from 'react';

const stages:any={selection:'方向选择',executor:'子任务执行',foreground:'主人聊天',scheduled:'定时模型任务'};
const fields:any={'domain.memories':'记忆','domain.summaries':'长期记忆整理摘要','domain.goals':'目标',ownerEvidence:'主人原话',history:'聊天历史',recent:'近期消息',learningNotes:'学习笔记','social.topicMemory.topics':'长期话题','social.recentTopics':'近期话题'};
const time=(n:any)=>n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
const quantity=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value.toLocaleString('zh-CN'):'未记录';

function RollingSummaryUsage({summary}:any){
  if(!summary||typeof summary!=='object')return <p className="hn-note">这条历史记录尚未记录滚动会话摘要用量。</p>;
  return <div className="hn-group"><h4>滚动会话摘要 · 本轮</h4>{summary.state==='included'?<>
    <p>已带入版本 {quantity(summary.version)} · {quantity(summary.bytes)} 预算单位</p>
    <p className="hn-note">对应较早会话 {quantity(summary.sourceTurnCount)} 轮／{quantity(summary.sourceMessageCount)} 条原消息。该范围表示有来源可追溯，不代表每句话都保留在摘要里。</p>
    <p className="hn-note">本次投影保留 {quantity(summary.includedItems)} 项，省略 {quantity(summary.omittedItems)} 项。原文继续保留，较新的原话和更正优先。</p>
    {summary.developmentOnly&&<p className="hn-note">当前是虚构开发测试段，仅供临时续聊，不计入真实偏好或人格成长。</p>}
  </>:summary.state==='budget-unavailable'?<p className="hn-note">已有有效摘要，但本轮预算未能同时容纳摘要和必要对话，摘要正文未带入。原摘要与原文没有删除；不会把省略的内容当作已经发送。</p>:summary.state==='not-enabled'?<p className="hn-note">此运行版本未启用滚动会话摘要服务。</p>:<p className="hn-note">本轮没有可带入的有效滚动摘要；可能尚未生成，或当前会话范围／来源已变化。不会沿用失效摘要。</p>}
    <p className="hn-note">滚动会话摘要用于接续较早的话题，与下方的长期记忆整理摘要不同；它是带来源的模型整理，不是新的事实或执行授权。</p>
  </div>;
}

function RollingSummaryState({state,preview,ui,onRetry,retrying}:any){
  const {Button}=ui;
  const labels:any={active:'已有有效摘要',held:'上次整理未完成，等待处理',interrupted:'上次整理被新输入打断',invalidated:'来源变化，旧摘要已停用',empty:'尚未生成摘要'};
  return <section className="hn-group"><h3>滚动会话摘要状态</h3><p>{labels[state.status]??'状态待核对'} · {state.developmentOnly?'当前虚构测试段':'日常会话'}</p>
    <p className="hn-note">有效版本 {quantity(state.version)} · 对应原始问答 {quantity(state.sourceTurnCount)} 轮／{quantity(state.sourceMessageCount)} 条 · 最近更新 {time(state.updated)}</p>
    <p className="hn-note">还有 {quantity(state.backlogTurns)} 轮较早问答待整理。生成与否、持久版本和“本轮实际带入”分别记录，不把待整理内容算成已压缩。</p>
    {['held','interrupted'].includes(state.status)&&<><p className="hn-note">{state.status==='interrupted'?'新输入已优先处理，旧有效摘要和原文保留。同一批内容不会被自动反复压缩；新增过期内容后会再判断，也可先暂停后明确允许重试。':'聊天可以继续，已有的有效摘要和原文保留；这次失败不会自动重试。'} 请先暂停 Human 并等待当前执行结束，再允许重新整理。此操作只保存许可，不会自动恢复运行或立即调用模型。</p><Button disabled={retrying} onClick={onRetry}>允许重新整理会话摘要</Button></>}
    {typeof state.evictedChunks==='number'&&state.evictedChunks>0&&<p className="hn-note">有 {quantity(state.evictedChunks)} 份更早的摘要块已不在当前滚动集合，原文仍保留；这不是无限历史逐字记忆。</p>}
    <p className="hn-note">原始消息保留并关联来源。更正、撤回和会话范围变化会重新核对有效性，摘要不会自行变成偏好、人格或工具授权。</p>
    {preview&&typeof preview==='object'&&<details><summary>查看当前摘要与来源</summary><p className="hn-note">仅展示本次重新核对后仍有效的摘要投影与来源摘录；模型整理的语义尚未独立核验。</p><pre className="hn-json">{JSON.stringify(preview,null,2)}</pre></details>}
  </section>;
}

function ContextRecord({report:r,label,ui}:any){
  const {Band}=ui,review=r?.kind==='development-review';
  return <section className="hn-group"><h3>{label}</h3>{!r||typeof r!=='object'?<p className="hn-note">新版尚未记录该阶段的模型上下文。</p>:<>
    <p>{time(r.time)} · 装入 {quantity(r.estimatedInput)} / {quantity(r.budget)} 预算单位</p>
    <p className="hn-note">固定必需内容 {quantity(r.required)} 单位 · 装配前候选内容 {quantity(r.inputBytes)} 单位</p>
    {typeof r.historyTurnCount==='number'&&<p className="hn-note">近期完整对话：装入 {quantity(r.recentHistoryTurnCount??r.historyTurnCount)} 轮，候选 {quantity(r.candidateRecentHistoryTurnCount??r.candidateHistoryTurnCount)} 轮。下方聊天历史的“条”按实际消息计数。</p>}
    {typeof r.pendingBridgeCandidateTurns==='number'&&<p className="hn-note">待压缩过渡原文：候选 {quantity(r.pendingBridgeCandidateTurns)} 轮，装入 {quantity(r.pendingBridgeIncludedTurns)} 轮，省略 {quantity(r.pendingBridgeOmittedTurns)} 轮。最多额外带入3轮完整原文，补足近期窗口与下一批摘要之间的间隔，不将其计为已压缩。</p>}
    {r.lane==='foreground'&&<RollingSummaryUsage summary={r.conversationSummary}/>}
    {review?<>
      <p className="hn-note">本轮类型：记忆整理与人格回顾。材料数量按回顾任务单独记录。</p>
      <p className="hn-note">记忆整理材料：{quantity(r.counts?.memory)} 条</p>
      <p className="hn-note">人格回顾依据：{quantity(r.counts?.personaEvidence)} 条</p>
      <p className="hn-note">这类记录不包含普通聊天的逐类省略统计；缺失字段显示“未记录”，不按零计算。</p>
    </>:Object.entries(fields).map(([key,name])=><p className="hn-note" key={key}>{name as string}：装入 {quantity(r.counts?.[key])} 条，因输入预算省略 {quantity(r.omitted?.[key])} 条</p>)}
    {typeof r.importantFactsOmitted==='number'&&r.importantFactsOmitted>0&&<Band>有 {quantity(r.importantFactsOmitted)} 条重要事实候选未装入。可在“模型与执行”提高该阶段输入预算。</Band>}
    {Array.isArray(r.memoryRefs)?<details><summary>本轮记忆编号与版本</summary><pre className="hn-json">{JSON.stringify(r.memoryRefs,null,2)}</pre></details>:<p className="hn-note">这条记录未保存记忆编号与版本。</p>}
  </>}</section>;
}

export default function ContextStatus({api,ui}:any){
  const {Button,Band,Empty,ReadState,useRead}=ui;
  const [nonce,setNonce]=useState(0),[retrying,setRetrying]=useState(false),[retryError,setRetryError]=useState(''),result=useRead(api,{kind:'context-status'},nonce);
  const retry=async()=>{if(retrying)return;setRetrying(true);setRetryError('');try{await api.control({op:'conversation-summary-retry'});setNonce(value=>value+1);}catch(error:any){const code=error?.message??String(error);setRetryError(code==='PAUSE_REQUIRED'?'请先暂停 Human 并等待当前执行结束，再允许重新整理。':ui.errorText?.(code)??code);}finally{setRetrying(false);}};
  return <><div className="hn-row hn-between"><h3>每轮实际带入的上下文</h3><Button onClick={()=>setNonce(n=>n+1)}>刷新状态</Button></div>
    <Band>聊天带入近期完整问答、较早会话的滚动摘要，再按相关性补充长期记忆与目标。摘要每轮核对来源，较新的更正优先；预算不足时先缩减完整摘要条目，并明确记录未装入内容。人格只装入一份，原始对话与记忆继续保留。</Band>
    <ReadState result={result}>{(data:any)=><>
      {retryError&&<Band>{retryError}</Band>}
      {data?.rolling&&typeof data.rolling==='object'&&<RollingSummaryState state={data.rolling} preview={data.rollingPreview} {...{ui,retrying}} onRetry={retry}/>}
      {data?.current?<section className="hn-group"><h3>当前状态摘要 · {time(data.current.at)}</h3>
        <p>最近有效用户消息：{time(data.current.owner?.lastMessage?.at)}。当前情绪与身体状态需重新确认。</p>
        <p>{data.current.contact?.quiet===true?'当前在静默时段':data.current.contact?.quiet===false?'当前不在静默时段':'静默状态未记录'} · 最近主动联系：{time(data.current.contact?.lastContact)}</p>
        <p>待继续任务 {quantity(data.current.pendingTaskCount)} 项 · 待处理定时事项 {quantity(data.current.reminderCount)} 项{data.current.authorization?.awaitingExtraBudget?' · 正等待额外额度授权':''}</p>
        {data.current.currentTask&&<p>当前待继续任务：{data.current.currentTask.kind} · {data.current.currentTask.status}</p>}
        <details><summary>状态字段与任务编号</summary><pre className="hn-json">{JSON.stringify(data.current,null,2)}</pre></details>
      </section>:<Empty>运行模块连接后可读取当前状态摘要。</Empty>}
      {Object.entries(stages).map(([lane,label])=><ContextRecord key={lane} label={label} report={data?.last?.[lane]} ui={ui}/>)}
      <Band>输入预算按实际序列化内容的 UTF-8 字节数加 256 单位封装预留计算，不是模型分词结果；供应商实际 token 见事件日志。固定指令、核心人格、当前输入、当前任务和执行所需来源不会被截断，必需内容超限时会停止该次调用并记录错误。历史摘录只作背景。该页为只读，不调用模型；“最近一轮”保留当时的编号与版本。</Band>
    </>}</ReadState>
  </>;
}
