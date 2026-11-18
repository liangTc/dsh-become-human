import React,{useEffect,useState} from 'react';
import {useRetainedRead} from './native-disclosure';
import {ConversationRecords} from './native-conversation';
import {ModelExchange} from './native-model-record';
import RecordDetails from './native-records';
import {moveTab} from './native-shell';

const labels:Record<string,string>={ready:'已排队',executing:'执行中',suspended:'保留进度，等待续行','waiting-budget':'等待额度',completed:'执行完成',failed:'执行失败',cancelled:'本轮已终止',archived:'主记录已归档',inflight:'正在调用',selected:'已选择方向',executed:'调用已完成','validation-rejected':'输出检查未通过',succeeded:'调用成功',success:'调用成功',unknown:'调用结果未知'};
const kinds:Record<string,string>={behavior:'扩展行为','behavior-choice':'选择下一步',research:'公开研究','learn-ai':'来源学习',chat:'主动闲聊','social-chat':'主动闲聊',care:'主动关心','share-insight':'分享学习','share-learning':'分享学习','write-report':'整理报告'};
const eventNames:Record<string,string>={'behavior-selected':'选择当前行为','behavior-result':'保存行为执行结果','experience-recorded':'保存数字经历','experience-reflected':'回顾经历与调整方法','task-created':'创建任务','goal-task-attached':'关联目标步骤','context-assembled':'整理本轮上下文',dispatch:'发出模型请求','attempt-selected':'选择模型返回方向','task-ready':'任务准备就绪','task-executing':'开始执行任务','attempt-executed':'执行模型返回结果','learning-rejected':'学习结果未通过检查','attempt-validation-rejected':'记录输出检查问题','autonomy-turn-ended':'本轮处理结束','goal-blocked':'目标等待处理','direction-selected':'确定执行方向','research-searched':'搜索公开资料','research-source-selected':'选择资料来源','source-fetched':'读取资料','executor-started':'开始分析资料','executor-completed':'分析结束','learning-committed':'保存学习结果','learning-failed':'学习未完成','learning-failed-quality':'学习质量检查未通过','result-reflected':'记录结果反思','task-suspended':'保存进度，等待续行','task-resumed':'继续任务','task-completed':'执行结束','task-failed':'执行失败','request-started':'开始模型调用','request-completed':'模型返回结果'};
const eventStates:Record<string,string>={submitted:'已发起请求',success:'已记录',active:'进行中',failed:'未完成',running:'执行中',blocked:'受阻',cancelled:'已终止',unknown:'结果未知'};
const time=(n:any)=>n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'未记录';
const text=(v:any)=>typeof v==='string'?v:v?.summary??v?.message??v?.reason??'';

export default function TaskExecutionDetail({api,id,onClose,onSection,ui}:any){
 const {Detail,ReadState,Button,Band,RecordContent}=ui,[nonce,setNonce]=useState(0),[tab,setTab]=useState('result'),r=useRetainedRead(api,{kind:'task',taskId:id},nonce);
 useEffect(()=>{const timer=setInterval(()=>setNonce(n=>n+1),15000);return()=>clearInterval(timer);},[id]);
 return <Detail title="任务执行记录" onClose={onClose}>{r.error&&r.data?<Band>刷新失败：{ui.errorText(r.error)}。保留上次记录。</Band>:null}<ReadState result={{...r,loading:r.loading&&!r.data,error:r.data?'':r.error}}>{(task:any)=>{
  const p=task.checkpoint??{},plan=p.plan??p.candidate??{},goalId=task.goalId??p.goal?.id,attempts=task.attempts??[],trace=task.trace??[],reason=task.status==='completed'?null:p.failureDiagnostic?.code??p.reason??p.error??p.searchFailure?.code;
  return <><div className="hn-task-heading"><span className="hn-board-status">{p.reason==='selection-wait'?'选择等待':labels[task.status]??task.status}</span><h3>{plan.question??p.question??kinds[task.kind]??'任务执行'}</h3><p className="hn-note">{kinds[task.kind]??task.kind??'历史任务'} · 创建 {time(task.created)} · 更新 {time(task.updated)}</p></div>
   {reason?<Band>当前原因：{ui.errorText(text(reason))}</Band>:null}
   <div className="hn-row hn-between"><span/><Button onClick={()=>api.run(async()=>{ui.download(await api.read({kind:'task-export',taskId:id}),'human-task-log.json');},'日志已导出')}>导出日志</Button></div><nav className="hn-detail-tabs" role="tablist" aria-label="任务详情分类">{[['result','结果与下一步'],['conversation','关联对话'],['trace','执行记录'],['model','模型请求与返回']].map(([key,label])=><button type="button" role="tab" key={key} aria-selected={tab===key} tabIndex={tab===key?0:-1} onKeyDown={moveTab} onClick={()=>setTab(key)}>{label}</button>)}</nav>
   <div role="tabpanel" aria-label={{result:'结果与下一步',conversation:'关联对话',trace:'执行记录',model:'模型请求与返回'}[tab]}>
    {tab==='result'?<><section className="hn-task-result-overview"><h4>做了什么</h4><p className="hn-record-text">{p.behaviorResult?.summary??p.result?.summary??(p.reason==='selection-wait'?'本轮选择等待，没有继续发送消息或执行行动。':p.noteId?'已保存学习笔记。':p.actionId?'已关联文件产物。':task.status==='completed'?'本次执行已结束，未保留文字结果摘要。':'尚未取得最终结果。')}</p></section>
     {(plan.reason??plan.why??p.reason)&&<section className="hn-task-result-overview"><h4>选择依据</h4><p className="hn-record-text">{ui.errorText(text(plan.reason??plan.why??p.reason))}</p></section>}
     {(p.behaviorResult??p.result)&&<RecordContent value={Object.fromEntries(Object.entries(p.behaviorResult??p.result??{}).filter(([key])=>!["summary","reason","why"].includes(key)))}/>}
     {task.status==='suspended'?<Band>进度已保存，等待同一执行线继续处理。</Band>:null}
     <div className="hn-row hn-dialog-actions">{goalId&&onSection?<Button onClick={()=>{onClose();onSection('goals');}}>管理所属目标</Button>:!goalId&&task.status==='failed'?<><p className="hn-note">重试前请暂停 Human 并等待当前执行结束。</p><Button disabled={api.snapshot.busy||api.snapshot.state?.desired!=='paused'||api.snapshot.state?.agentBusy} onClick={()=>api.run(async()=>{await api.control({op:'autonomy-retry-task',taskId:id});setNonce(n=>n+1);},'已重新排队，请恢复运行')}>重试此任务</Button></>:null}{p.noteId&&onSection?<Button onClick={()=>{onClose();onSection('notes');}}>查看学习笔记</Button>:null}{p.actionId&&onSection?<Button onClick={()=>{onClose();onSection('actions');}}>查看文件产物</Button>:null}<Button onClick={()=>setTab('trace')}>查看执行经过</Button></div>
    </>:tab==='model'?<ModelExchange {...{api,ui}} taskId={id} attempts={attempts}/>:tab==='conversation'?<ConversationRecords key={id} {...{api,ui}} taskId={id}/>:tab==='trace'?<>
     <div className="hn-row hn-between"><p>{attempts.length} 次模型调用 · {trace.length} 条事件</p><Button disabled={r.loading} onClick={()=>setNonce(n=>n+1)}>刷新记录</Button></div>
     {attempts.length>0&&<section className="hn-task-attempt-summary"><h4>模型调用</h4>{attempts.map((a:any,index:number)=><div className="hn-attempt-row" key={a.id}><div><strong>第 {index+1} 次 · {labels[a.state]??a.state}</strong><p className="hn-note">{time(a.started)} 至 {time(a.ended)}</p>{a.error&&<p>{ui.errorText(text(a.error))}</p>}</div>{a.usage&&<span className="hn-note">输入 {a.usage.inputTokens??'未知'} / 输出 {a.usage.outputTokens??'未知'} token</span>}</div>)}</section>}
     <ol className="hn-execution-trace">{trace.map((e:any)=><li key={e.id}><header><strong>{eventNames[e.kind]??(/[\u4e00-\u9fff]/u.test(e.title??'')?e.title:'处理记录')}</strong><span>{eventStates[e.status]??'已记录'}</span><time>{time(e.time)}</time></header>{e.data?.summary&&<p>{text(e.data.summary)}</p>}<RecordDetails value={e.data} label="查看内容"/></li>)}</ol>{!trace.length&&<p className="hn-note">暂无保留事件。未记录的过程不会补写为已发生。</p>}
    </>:null}
   </div>
  </>;
 }}</ReadState></Detail>;
}
