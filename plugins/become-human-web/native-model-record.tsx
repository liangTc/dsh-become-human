import React,{useState} from 'react';
import {useRetainedRead} from './native-disclosure';
import {modelText} from './record-presentation.mjs';

function Content({value,expand=false}:any){
 const v=modelText(value);
 if(v===null)return <p className="hn-note">这部分没有可读正文；完整结构可通过任务日志导出。</p>;
 return <Projected value={v} expand={expand}/>;
}
function Projected({value,expand=false}:any){
 if(value===null||typeof value!=='object')return <p className="hn-record-text">{String(value??'')}</p>;
 if(Array.isArray(value))return <ul className="hn-record-list">{value.map((v,i)=><li key={i}><Projected value={v} expand={expand}/></li>)}</ul>;
 return <div>{Object.entries(value).map(([k,v])=><details key={k+':'+expand} open={expand} className="hn-model-section"><summary>{k}</summary><Projected value={v} expand={expand}/></details>)}</div>;
}
function CallRecord({api,ui,attemptId,taskId}:any){
 const [expand,setExpand]=useState(false),r=useRetainedRead(api,{kind:'model-record',taskId,attemptId});
 return <ui.ReadState result={r}>{(record:any)=><>
  <p className="hn-note">来自这次调用保存的记录，隐藏内部引用与图片编码。完整结构可导出日志。</p>
  <div className="hn-row hn-between"><h4>发给模型的内容</h4><ui.Button onClick={()=>setExpand(v=>!v)}>{expand?"收起请求内容":"展开全部请求内容"}</ui.Button></div><ol className="hn-transcript">{record.messages.map((message:any,index:number)=><li className="hn-transcript-message" key={index}><details key={String(expand)} open={expand}><summary>{({system:'人物与任务要求',user:'输入内容',assistant:'之前的回复',tool:'工具结果'} as any)[message.role]??'相关内容'}</summary>{Array.isArray(message.content)?message.content.map((part:any,i:number)=>part.type==='text'?<Content key={i} value={part.text} expand={expand}/>:<p key={i} className="hn-note">图片或其他附件</p>):<Content value={message.content} expand={expand}/>}</details></li>)}</ol>
  <h4>模型返回</h4>{record.responseRecorded?<>{record.response?.trim()?<Content value={record.response} expand/>:<p className="hn-note">本次调用没有返回正文。</p>}{record.error&&<p className="hn-note">这次调用未完成：{ui.errorText(record.error)}</p>}</>:<p className="hn-note">{['prepared','dispatched'].includes(record.state)?'正在等待模型返回。':'这条历史调用没有保存返回原文，无法还原。实际发出的消息可在“关联对话”查看。'}</p>}
 </>}</ui.ReadState>;
}
export function ModelExchange({api,ui,taskId,attempts}:any){
 const [selected,setSelected]=useState(''),id=selected||attempts.at(-1)?.id;
 if(!id)return <p className="hn-note">本任务没有保留模型调用。</p>;
 return <><label className="hn-field">选择一次调用<select value={id} onChange={event=>setSelected(event.target.value)}>{attempts.map((a:any,index:number)=><option key={a.id} value={a.id}>第 {index+1} 次 · {new Date(a.started).toLocaleString('zh-CN')}</option>)}</select></label><CallRecord key={id} {...{api,ui,taskId}} attemptId={id}/></>;
}
