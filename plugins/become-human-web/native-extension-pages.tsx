import React,{useEffect,useState} from 'react';
import ReactPage from './native-react-page';
import Extensions from './native-extensions';
import {SectionWorkspace,useDraftNavigation} from './native-shell';
import {useLocationValue} from './native-navigation';
const hookNames:Record<string,string>={input:'收到消息',selection:'选择行动',result:'行动结果',feedback:'用户反馈',memory:'记忆变化',growth:'人物成长',delivery:'回复发布'};
export default function PluginWorkspace({api,s,ui,renderSlot,pageSlot}:any){
 const [data,setData]=useState<any>(null),[error,setError]=useState(''),[nonce,setNonce]=useState(0),[active,setActive]=useLocationValue('humanPlugin','install'),[pageKey,setPageKey]=useState(''),navigation=useDraftNavigation();
 const reload=()=>setNonce(n=>n+1),{Band,Button,OptionalSection}=ui;
 useEffect(()=>{let live=true,timer:any;const read=async()=>{let delay=15000;try{const next=await api.read({kind:'plugin-center'});if(live){setData(next);setError('');delay=next.busy?2000:15000;}}catch{if(live)setError('插件列表暂时无法读取，请检查后台连接。');}finally{if(live)timer=setTimeout(read,delay);}};void read();return ()=>{live=false;clearTimeout(timer);};},[api,nonce]);
 const selected=data?.items.find((item:any)=>item.name===active),lifecycle=data?.lifecycle?.find((entry:any)=>entry.owner===active),pages=(data?.pages??[]).filter((page:any)=>page.packageName===active),page=pages.find((p:any)=>p.key===pageKey)??pages[0];
 const sections=[{id:'install',title:'安装与管理',description:'为 Human 添加可选能力，已有会话与记忆继续沿用。',group:'管理',keywords:'安装 更新 恢复 插件'},...(data?.items??[]).map((item:any)=>({id:item.name,title:item.title??item.name,description:item.description,group:'已安装',keywords:item.name}))];
 const choose=(key:string)=>navigation.navigate(()=>{setActive(key);setPageKey('');});
 return <SectionWorkspace kind="插件" sections={sections} active={active} onSelect={choose} headerActions={
  <div className="hn-row">
   <a className="hn-link" href="https://liangtc.github.io/dsh-become-human/" target="_blank" rel="noopener noreferrer" title="在新窗口打开插件开发手册">插件开发手册 <span aria-hidden="true">↗</span></a>
   <Button onClick={reload}>刷新</Button>
  </div>
 }>
  {error&&<Band>{error}</Band>}{!data?<p role="status">正在读取插件…</p>:<>
   {active==='install'?<Extensions {...{api,s,ui}} embedded catalog={data} onReload={reload}/>:!selected?<Band>该插件已移除，请从左侧选择其他插件。</Band>:<>
    <Extensions key={active} {...{api,s,ui}} embedded selected={active} catalog={data} onReload={reload}/>
    {data.pageError&&<Band>{data.pageError}</Band>}
    {data.busy?<Band>正在应用插件变更，完成后自动恢复页面…</Band>:selected.nodes?.every((node:any)=>node.disabled)?<Band>插件已停用。历史数据保留；启用后可使用它的页面和能力。</Band>:page?<>
     {pages.length>1&&<div className="hn-tabs" role="tablist" aria-label="插件页面">{pages.map((p:any)=><Button key={p.key} role="tab" aria-selected={page.key===p.key} onClick={()=>navigation.navigate(()=>setPageKey(p.key))}>{p.title}</Button>)}</div>}
     {page.version===2?(page.ready?<ReactPage key={page.fingerprint} {...{api,page,s,ui,renderSlot,pageSlot}}/>:<Band>插件页面尚未就绪，请检查后台是否运行，或更新插件。</Band>):page.blocks.map((block:any,i:number)=>block.type==='text'?<p key={i}>{block.text}</p>:block.type==='list'?<ul key={i}>{block.items.map((text:string,n:number)=><li key={n}>{text}</li>)}</ul>:block.type==='runtime-status'?<p key={i}>{s.management.profile.name} · {s.desired==='running'?'运行中':'已暂停'}</p>:null)}
    </>:<p className="hn-note">此插件没有专属页面，已注册的能力由 Human 统一调用。</p>}
    {lifecycle&&<OptionalSection title="参与的环节与定时活动"><p>{lifecycle.hooks.map((name:string)=>hookNames[name]??name).join('、')||'通过已注册的动作或工具参与'}</p>{lifecycle.held.length>0&&<Band>部分插件回调出现错误并已停止：{lifecycle.held.map((name:string)=>hookNames[name]??name).join('、')}。请导出日志排查。</Band>}{lifecycle.schedules.map((row:any)=><div className="hn-line" key={row.id}><strong>{row.title}</strong><p>{row.status==='pending'?'下次检查：'+new Date(row.nextAt).toLocaleString():row.status==='completed'?'已触发':'异常，等待处理'}</p></div>)}{!lifecycle.schedules.length&&<p className="hn-note">未注册额外定时活动。</p>}</OptionalSection>}
   </>}
  </>}
 </SectionWorkspace>;
}
