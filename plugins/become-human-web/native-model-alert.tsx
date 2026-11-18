import React,{useState,useRef,useEffect} from 'react';
import {activeModelAlerts} from './model-alerts.mjs';
export default function ModelAlerts({s,onSection}:any){
 const alerts=activeModelAlerts(s),signature=JSON.stringify([s.sessionId,...alerts.map((item:any)=>[item.scope,item.attemptId,item.code,item.at])]);
 const [minimized,setMinimized]=useState(''),[expanded,setExpanded]=useState('');
 const chip=useRef<HTMLButtonElement>(null),restoreFocus=useRef(false);
 useEffect(()=>{if(minimized===signature&&restoreFocus.current){chip.current?.focus();restoreFocus.current=false;}},[minimized,signature]);
 if(!alerts.length)return null;
 const collapse=(focus=true)=>{restoreFocus.current=focus;setMinimized(signature);setExpanded('');};
 const navigate=(section:string)=>{collapse(false);onSection(section);};
 return <aside className="hn-model-alerts" aria-label="运行异常通知" onKeyDown={event=>{if(event.key==='Escape'){setExpanded('');if(minimized!==signature)collapse();}}}>
 {minimized===signature?<button ref={chip} type="button" className="hn-model-alert-chip" onClick={()=>setMinimized('')} aria-label={'展开异常通知，共 '+alerts.length+' 项'}><span aria-hidden="true">!</span> 异常 {alerts.length}</button>:alerts.map((item:any)=>{const key=signature+':'+item.scope,open=expanded===key;return <section key={key} className="hn-model-alert">
  <div className="hn-model-alert-heading"><strong>{item.scope==='autonomous'?'自主活动因异常暂停':'本轮对话未完成'}</strong><button type="button" className="hn-model-alert-close" onClick={()=>collapse()} aria-label="收起异常通知" title="收起为小提醒">−</button></div>
  <p role="alert" className="hn-model-alert-summary">{item.summary}</p>
  <details open={open} onToggle={event=>{const next=event.currentTarget.open;setExpanded(current=>next?key:current===key?'':current);}}><summary>查看错误详情与影响</summary><p>{item.suggestion}</p><dl>
   <dt>本次请求</dt><dd>{item.provider??'未记录服务商'} / {item.model??'未记录模型'}</dd>
   <dt>发生时间</dt><dd>{item.at?new Date(item.at).toLocaleString('zh-CN',{hour12:false}):'旧记录未保存'}</dd>
   <dt>错误码</dt><dd>{item.code}{item.upstreamCode?' · 上游 '+item.upstreamCode:''}</dd>
   <dt>HTTP 状态</dt><dd>{item.httpStatus??'上游未提供或旧版本未保存'}</dd>
   <dt>上游说明（已脱敏）</dt><dd>{item.upstreamMessage||'没有保留可展示的上游说明，不能确认是否为模型下线。'}</dd>
   <dt>调用编号</dt><dd>{item.attemptId??'请求准备阶段，尚无调用编号'}</dd>
  </dl>{item.legacy&&<p>这是旧版本的失败记录，无法补回当时丢失的上游信息。</p>}
  <p>{item.scope==='autonomous'?'自主选题和后续行动已暂停；你仍可输入聊天，但若共用故障模型，回复也可能失败。':'本轮未取得成功回复；请先处理模型问题，再明确重试。'}会话与记忆已保留，不会自动重发失败请求。</p></details>
  <div className="hn-row"><button type="button" className="hn-button" onClick={()=>navigate('model')}>检查模型设置</button><button type="button" className="hn-button" onClick={()=>navigate('runtime')}>诊断与恢复</button></div>
 </section>;})}</aside>;
}
