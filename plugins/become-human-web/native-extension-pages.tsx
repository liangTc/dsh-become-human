import ReactPage from './native-react-page';
import React,{useEffect,useState} from 'react';
import {SectionWorkspace} from './native-shell';
import {useLocationValue} from './native-navigation';

export function useExtensionPages(api:any){
 const [result,setResult]=useState<any>({pages:[],error:'',loading:true});
 useEffect(()=>{let live=true,timer:any;const read=async()=>{try{const value=await api.read({kind:'extension-pages'});if(live)setResult({pages:value.pages,error:'',loading:false});}catch{if(live)setResult({pages:[],error:'扩展页面暂时无法读取，请检查后台连接。',loading:false});}finally{if(live)timer=setTimeout(read,5000);}};void read();return ()=>{live=false;clearTimeout(timer);};},[api]);
 return result;
}
export default function ExtensionPages({catalog,api,s,ui,renderSlot,pageSlot}:any){
 const [active,setActive]=useLocationValue('humanExtension',''),page=catalog.pages.find((entry:any)=>entry.key===active)??(!active?catalog.pages[0]:null),{Band}=ui;
 if(catalog.error)return <div className="hn-content"><Band>{catalog.error}</Band></div>;
 if(catalog.loading)return <div className="hn-content"><Band>正在读取扩展页面…</Band></div>;
 if(!catalog.pages.length)return <div className="hn-content"><h2>扩展页面</h2><p>暂无已启用的扩展页面。可以在设置 → 工具与技能 → 行为扩展中安装或启用。</p></div>;
 const sections=catalog.pages.map((entry:any)=>({id:entry.key,title:entry.title,description:entry.description,group:entry.packageName,keywords:entry.title+' '+entry.packageName}));
 return <SectionWorkspace kind="扩展" sections={sections} active={page?.key??active} onSelect={setActive}>
  {!page?<Band>此页面已停用或移除，请选择其他扩展页面。</Band>:<><p className="hn-note">来自 {page.packageName} · {page.packageVersion}</p>{page.version===2?(page.ready?<ReactPage key={page.fingerprint} {...{api,page,s,ui,renderSlot,pageSlot}}/>:<Band>扩展前台或后台接口尚未就绪，请核对安装状态。</Band>):page.blocks.map((block:any,index:number)=>block.type==='text'?<p key={index} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{block.text}</p>:block.type==='list'?<ul key={index}>{block.items.map((item:string,i:number)=><li key={i}>{item}</li>)}</ul>:block.type==='runtime-status'?<section className="hn-card" key={index} aria-label="扩展运行状态"><h3>当前 Human</h3><p>{s.management.profile.name} · {s.desired==='running'?'运行中':'已暂停'}</p><p>{s.autonomy?.paused?'自主活动已暂停':'自主活动可用'} · 与网页共享原会话</p></section>:null)}</>}
 </SectionWorkspace>;
}
