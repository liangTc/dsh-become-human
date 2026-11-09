import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

const modules=new Map<string,any>();
function acquire(api:any,page:any){
 let entry=modules.get(page.moduleId);
 if(!entry){
  const script=document.createElement('script');script.src='/become-human-extension-client.js?'+new URLSearchParams({key:page.key,fingerprint:page.fingerprint});script.async=true;
  entry={count:0,script,cancel:null};const current=entry;
  entry.promise=new Promise((resolve,reject)=>{let cancelled=false;const cleanup=()=>{clearTimeout(timer);script.remove();};const cancel=(code:string)=>{cancelled=true;cleanup();api.ctx.modules.invalidate(page.moduleId);reject(Error(code));};const timer=setTimeout(()=>cancel('EXTENSION_CLIENT_TIMEOUT'),15000);current.cancel=()=>cancel('EXTENSION_CLIENT_LOAD_CANCELLED');script.onload=()=>{cleanup();if(cancelled){api.ctx.modules.invalidate(page.moduleId);return;}api.ctx.modules.import(page.moduleId).then(resolve,reject);};script.onerror=()=>{cleanup();reject(Error('EXTENSION_CLIENT_LOAD_FAILED'));};document.head.appendChild(script);});modules.set(page.moduleId,entry);
 }
 entry.count++;let released=false;
 return {promise:entry.promise,release:()=>{if(released)return;released=true;if(--entry.count===0){entry.cancel();modules.delete(page.moduleId);}}};
}
class PageBoundary extends React.Component<any,{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<div role="alert">扩展页面运行出错，其他 Human 页面仍可使用。<button onClick={this.props.retry}>重新加载页面</button></div>:this.props.children;}
}
const labels:Record<string,string>={EXTENSION_RPC_TIMEOUT:'扩展响应超时。写操作可能已执行，请先核对结果，不要直接重试。',EXTENSION_RPC_RESULT_UNKNOWN:'上次写入结果不明，请先核对扩展数据，不会自动重发。',EXTENSION_RPC_APPROVAL_EXPIRED:'确认已过期，请重新发起操作。',EXTENSION_PAGE_STALE:'扩展已更新，请重新打开页面。',EXTENSION_PAGE_UNAVAILABLE:'扩展已停用或移除。',EXTENSION_RPC_METHOD_NOT_ALLOWED:'此页面没有声明该接口。',EXTENSION_RPC_DISPOSED:'扩展已卸载或后台已重启。',EXTENSION_RPC_CANCELLED:'已取消操作。'};
export default function ReactPage({api,page,s,ui,renderSlot,pageSlot}:any){
 const container=useRef<HTMLDivElement>(null),[shadow,setShadow]=useState<ShadowRoot|null>(null),[ready,setReady]=useState(false),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[approval,setApproval]=useState<any>(null),pending=useRef<any>(null),life=useRef<AbortController|null>(null);
 const {Button,Detail}=ui;
 useEffect(()=>{if(container.current)setShadow(container.current.shadowRoot??container.current.attachShadow({mode:'open'}));},[]);
 useEffect(()=>{
  setReady(false);setError('');const controller=new AbortController();life.current=controller;let dispose:any;const loaded=acquire(api,page);
  loaded.promise.then((module:any)=>{if(controller.signal.aborted)return;const Component=module.default??module.Page;if(module.contractVersion!==2||typeof Component!=='function')throw Error('EXTENSION_CLIENT_CONTRACT_INVALID');const GuardedPage=(props:any)=><PageBoundary retry={()=>setNonce(n=>n+1)}><Component {...props}/></PageBoundary>;dispose=api.ctx.slots.register({name:pageSlot,key:page.fingerprint},GuardedPage);setReady(true);}).catch((e:any)=>{if(!controller.signal.aborted)setError(labels[e.message]??'扩展页面无法加载，请检查安装包或重新打开。');});
  return ()=>{controller.abort();pending.current?.resolve(false);pending.current=null;setApproval(null);dispose?.();loaded.release();};
 },[api,page.fingerprint,pageSlot,nonce]);
 const call=useCallback(async(method:string,payload:any=null)=>{
  const controller=life.current;if(!controller||controller.signal.aborted)throw Error('EXTENSION_RPC_DISPOSED');
  const descriptor=page.methods.find((m:any)=>m.name===method);if(!descriptor)throw Error('EXTENSION_RPC_METHOD_NOT_ALLOWED');
  const request={key:page.key,fingerprint:page.fingerprint,method,payload};
  try{
   let result;
   if(descriptor.mode==='read')result=await api.read({kind:'extension-page-call',...request});
   else{
    if(pending.current)throw Error('EXTENSION_RPC_BUSY');
    const reservation:any={resolve:null};pending.current=reservation;
    try{
     const prepared=await api.control({op:'extension-page-prepare',...request});if(controller.signal.aborted)throw Error('EXTENSION_RPC_DISPOSED');
     const confirmed=await new Promise<boolean>(resolve=>{reservation.resolve=resolve;setApproval({...prepared,resolve});});setApproval(null);if(!confirmed)throw Error('EXTENSION_RPC_CANCELLED');if(controller.signal.aborted)throw Error('EXTENSION_RPC_DISPOSED');
     result=await api.control({op:'extension-page-call',...request,token:prepared.token,requestId:prepared.requestId});
    }finally{if(pending.current===reservation)pending.current=null;}
   }
   if(controller.signal.aborted)throw Error('EXTENSION_RPC_DISPOSED');return result.value;
  }catch(e:any){throw Error(labels[e.message]??e.message);}
 },[api,page.fingerprint,s.sessionId]);
 const retry=()=>setNonce(n=>n+1),human=useMemo(()=>({contractVersion:2,sessionId:s.sessionId,call,signal:life.current?.signal}),[call,s.sessionId,ready,nonce]);
 return <>
  {error?<div role="alert">{error} <Button onClick={retry}>重新加载页面</Button></div>:!ready?<p role="status">正在加载扩展页面…</p>:null}
  <div ref={container}/>
  {shadow&&ready&&createPortal(<><style>{`:host{display:block;color:#24343b;font:14px/1.7 system-ui,sans-serif}*{box-sizing:border-box}button,input,select,textarea{font:inherit;max-width:100%}button{cursor:pointer;padding:6px 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}`}</style><PageBoundary key={page.fingerprint+':'+nonce} retry={retry}>{renderSlot(pageSlot,{human},{entryKey:page.fingerprint})}</PageBoundary></>,shadow)}
  {approval&&<Detail title="确认扩展写操作" onClose={()=>approval.resolve(false)}><p><strong>{approval.title}</strong> · {approval.method}</p><p>{approval.description}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{JSON.stringify(approval.payload,null,2)}</pre><p>只批准这一次调用。结果不明时不会自动重试。</p><div className="hn-row"><Button onClick={()=>approval.resolve(false)}>取消</Button><Button primary onClick={()=>approval.resolve(true)}>确认执行一次</Button></div></Detail>}
 </>;
}
