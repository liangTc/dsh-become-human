import React,{useState} from 'react';
import {RecordContent} from './native-records';
const time=(value:any)=>value?new Date(value).toLocaleString('zh-CN'):'尚无记录';
const stages:any={selection:'选择下一步',executor:'执行任务',foreground:'日常聊天',scheduled:'定时任务'};
export default function ContextStatus({api,ui}:any){
 const {Button,Band,ReadState,useRead}=ui,[nonce,setNonce]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false),r=useRead(api,{kind:'context-status'},nonce);
 const retry=async()=>{setBusy(true);setError('');try{await api.control({op:'conversation-summary-retry'});setNonce(n=>n+1);}catch(e:any){setError(ui.errorText(e.message));}finally{setBusy(false);}};
 return <><div className="hn-row hn-between"><h3>对话与记忆如何接续</h3><div className="hn-row"><Button onClick={()=>setNonce(n=>n+1)}>刷新</Button><Button disabled={!r.data} onClick={()=>ui.download(r.data,'human-context-log.json')}>导出日志</Button></div></div>
 <p>聊天结合近期原话、较早对话的摘要，以及相关记忆与目标。原始对话继续保留，你的最新更正优先。</p>
 {error&&<Band>{error}</Band>}<ReadState result={r}>{(data:any)=>{
 const summary=data.rolling,labels:any={active:'摘要可用',held:'部分对话待重新整理',interrupted:'整理被新消息打断',invalidated:'原内容有变化，等待重新整理',empty:'还没有需要整理的摘要'};
 return <><section className="hn-group"><h4>较早的对话</h4><p>{labels[summary?.status]??'尚无摘要记录'} · 最近更新 {time(summary?.updated)}</p>{summary?.backlogTurns>0&&<p>还有 {summary.backlogTurns} 轮较早对话待整理。</p>}
 {data.rollingPreview&&<details><summary>查看摘要内容</summary><RecordContent value={data.rollingPreview}/></details>}
 {['held','interrupted'].includes(summary?.status)&&<><p className="hn-help">{summary.status==='held'?'先前失败的批次已单独保留，后续新对话可以继续整理。':'已有摘要和原文仍然保留。'}暂停 Human 后，可允许再次整理。</p><Button disabled={busy} onClick={retry}>允许重新整理</Button></>}
 </section><section className="hn-group"><h4>最近一次使用情况</h4>{Object.entries(stages).map(([lane,label])=>{const row=data.last?.[lane];return <div className="hn-line" key={lane}><div><strong>{String(label)}</strong><p className="hn-note">{time(row?.time)}</p>{row?<p>近期对话 {row.recentHistoryTurnCount??row.historyTurnCount??0} 轮 · 相关记忆 {row.counts?.['domain.memories']??0} 条{row.conversationSummary?.state==='included'?' · 已带入较早对话摘要':''}</p>:<p>尚无记录</p>}</div></div>;})}</section></>;
 }}</ReadState></>;
}
