import React,{useEffect,useState} from 'react';
export const contractVersion=2;
export default function Page({human}:any){
 const [count,setCount]=useState<number|null>(null),[same,setSame]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[crash,setCrash]=useState(false);
 const accept=(value:any)=>{if(typeof value.count==='number')setCount(value.count);if(value.sessionId)setSame(value.sessionId===human.sessionId);};
 useEffect(()=>{let live=true;human.call('counter.read').then((v:any)=>{if(live)accept(v);}).catch((e:any)=>{if(live)setMessage(e.message);});return ()=>{live=false;};},[human.call]);
 const run=async(method:string,payload:any=null)=>{setBusy(true);setMessage('');try{accept(await human.call(method,payload));if(!human.signal.aborted)setMessage('操作完成');}catch(e:any){if(!human.signal.aborted)setMessage(e.message);}finally{if(!human.signal.aborted)setBusy(false);}};
 if(crash)throw Error('Sample React rendering failure');
 return <section className="sample"><style>{`.sample{border:1px solid #cbdedc;border-radius:12px;padding:24px;background:#f6fbfa}.sample h2{margin:0 0 12px}.sample output{display:block;font-size:40px;font-weight:600;margin:18px 0}.sample .actions{display:flex;gap:10px;flex-wrap:wrap}.sample button{border:1px solid #b5cfcc;border-radius:7px;background:white;color:#244843}.sample p{overflow-wrap:anywhere}`}</style>
  <h2>React 计数器</h2><p>{same?'当前使用 Human 原会话':'正在核对会话'}</p><output aria-label="示例计数">{count===null?'正在读取…':count}</output>
  <div className="actions"><button disabled={busy} onClick={()=>run('counter.read')}>刷新计数</button><button disabled={busy} onClick={()=>run('counter.add',{amount:1})}>增加一次</button></div><p role="status">{busy?'正在等待操作完成…':message}</p>
  <details><summary>错误与生命周期演示</summary><div className="actions"><button disabled={busy} onClick={()=>run('sample.error')}>测试接口错误</button><button disabled={busy} onClick={()=>run('sample.slow')}>测试超时</button><button onClick={()=>setCrash(true)}>测试页面异常</button></div></details>
  <p>此示例只操作自己的计数文件，不修改人格、记忆或聊天，不调用模型。</p>
 </section>;
}
