import React,{useEffect,useState} from 'react';
import {useDraftGuard,useSectionContext} from './native-shell';

function settingsOf(value:any){const result=structuredClone(value?.settings??value??{});delete result.revision;return result;}
function draftOf(value:any){const settings=settingsOf(value);return {settings,sessionIds:(settings.bridge?.allowedSessionIds??[]).join('\n'),origins:(settings.bridge?.browser?.allowedOrigins??[]).join('\n'),targetIds:(settings.bridge?.browser?.allowedTargetIds??[]).join('\n')};}
const split=(text:string)=>Array.from(new Set(text.split(/[\r\n,，]+/).map(item=>item.trim()).filter(Boolean)));

function CapabilityForm({api,s,busy,ui,server,onRefresh,readError}:any){
  const {Button,Field,Input,Text,Check,Band,JsonDetails}=ui,section=useSectionContext();
  const [base,setBase]=useState(()=>({revision:server.revision??0,draft:draftOf(server)})),[draft,setDraft]=useState(()=>draftOf(server));
  const dirty=JSON.stringify(draft)!==JSON.stringify(base.draft),stale=(server.revision??0)!==base.revision;
  useDraftGuard(dirty);
  useEffect(()=>{if(!dirty){const next=draftOf(server);setBase({revision:server.revision??0,draft:next});setDraft(next);}},[server]);
  const settings=draft.settings,bridge=settings.bridge??{},browser=bridge.browser??{},mcp=settings.mcp??{};
  const patchBridge=(key:string,value:any)=>setDraft(previous=>({...previous,settings:{...previous.settings,bridge:{...previous.settings.bridge,[key]:value}}}));
  const patchBrowser=(key:string,value:any)=>setDraft(previous=>({...previous,settings:{...previous.settings,bridge:{...previous.settings.bridge,browser:{...previous.settings.bridge?.browser,[key]:value}}}}));
  const save=()=>api.run(async()=>{
    const next={...draft.settings,bridge:{...bridge,allowedSessionIds:split(draft.sessionIds),browser:{...browser,allowedOrigins:split(draft.origins),allowedTargetIds:split(draft.targetIds)}}};
    await api.control({op:'capability-configure',expectedRevision:base.revision,settings:next});
    const fresh=await api.read({kind:'capability-settings'}),value=draftOf(fresh);setBase({revision:fresh.revision??0,draft:value});setDraft(value);onRefresh();
  },'工具与连接设置已保存，Human 仍保持暂停');
  return <><h3>工具与连接</h3><Band>连接范围仅作用于当前 Human。读取和写入分别开启；写操作仍需逐笔批准。其他 DSH 会话作为外部资料或执行目标，不改变 Human 的唯一主会话。</Band>
    <section className="hn-form-section"><h4 className="hn-section-heading">只读 MCP</h4><Check label="启用内置只读 MCP 服务" disabled={busy} value={mcp.bundledEnabled!==false} onChange={(enabled:boolean)=>setDraft(previous=>({...previous,settings:{...previous.settings,mcp:{...previous.settings.mcp,bundledEnabled:enabled}}}))}/><p className="hn-help">通过 MCP 协议提供只读能力。当前页面不运行任意外部服务器，也不需要填写密钥。可用工具在“任务 → 工具与能力”中查看。</p></section>
    <section className="hn-form-section"><h4 className="hn-section-heading">DSH 会话</h4><div className="hn-checks"><Check label="允许读取指定 DSH 会话" disabled={busy} value={bridge.sessionReadEnabled} onChange={(enabled:boolean)=>patchBridge('sessionReadEnabled',enabled)}/><Check label="允许向指定 DSH 会话发送消息" disabled={busy} value={bridge.sessionWriteEnabled} onChange={(enabled:boolean)=>patchBridge('sessionWriteEnabled',enabled)}/></div>
      <Field label="允许的 DSH 会话 ID · 每行一个" hint="仅明确列出的会话可访问。留空不授权任何会话；不是 Human 自身的主会话编号。"><Text value={draft.sessionIds} rows={4} disabled={busy} placeholder="粘贴需要访问的 DSH 会话 ID" onChange={(sessionIds:string)=>setDraft(previous=>({...previous,sessionIds}))}/></Field><p className="hn-help">读取结果带来源标识。发送消息先生成目标和正文预览，批准只绑定该任务与当前参数；不会自动把其他会话加入白名单。</p>
    </section>
    <section className="hn-form-section"><h4 className="hn-section-heading">浏览器页面与标签页</h4><Check label="启用浏览器连接" disabled={busy} value={browser.enabled} onChange={(enabled:boolean)=>patchBrowser('enabled',enabled)}/><div className="hn-fields"><Field label="本机浏览器调试地址" wide hint="填写已开启调试功能的本机浏览器地址，例如 http://127.0.0.1:9222。保存地址不会自动启动浏览器。"><Input value={browser.endpoint??'http://127.0.0.1:9222'} maxLength={2048} disabled={busy} onChange={(endpoint:string)=>patchBrowser('endpoint',endpoint)}/></Field><Field label="允许的网站来源 · 每行一个" hint="填写协议、域名和端口，例如 https://example.com 或 http://127.0.0.1:3090。留空不允许访问任何网站。"><Text value={draft.origins} disabled={busy} rows={4} placeholder="https://example.com" onChange={(origins:string)=>setDraft(previous=>({...previous,origins}))}/></Field><Field label="进一步限定标签页 ID · 每行一个，可留空" hint="留空允许访问上方已授权网站来源内的全部可见标签页。填写后，仅允许同时符合网站来源和这些精确 ID 的标签页；不使用标题猜测目标。"><Text value={draft.targetIds} disabled={busy} rows={4} placeholder="留空使用网站来源范围；填写则进一步限定标签页" onChange={(targetIds:string)=>setDraft(previous=>({...previous,targetIds}))}/></Field></div><p className="hn-help">浏览器中能读到的页面内容可能包含登录后的资料，请只加入需要使用的网站来源。每项导航、点击、输入等操作仍会预览精确标签页 ID、当前网站来源及本次参数，再逐笔批准。</p></section>
    <section className="hn-form-section"><h4 className="hn-section-heading">单次执行边界</h4><div className="hn-setting-summary"><span>每轮最多 {settings.limits?.maxToolCallsPerTurn??2} 次工具调用</span><span>默认超时 {Math.round((settings.limits?.timeoutMs??60000)/1000)} 秒</span><span>结果上限 {(settings.limits?.maxResultBytes??32768).toLocaleString('zh-CN')} 字节</span></div><p className="hn-help">具体工具可以使用更小上限。超时或连接中断时，已经提交的外部写操作会标为待核对，不自动重试。</p><JsonDetails value={settings.limits??{maxToolCallsPerTurn:2,timeoutMs:60000,maxResultBytes:32768}} label="查看执行上限"/></section>
    {stale&&<Band>连接设置已被其他页面修改，当前草稿已保留。请放弃草稿并重新打开此分类，再基于最新范围修改。</Band>}
    <div className="hn-save"><div><strong>{dirty?'有未保存的连接设置':'设置仅作用于当前 Human'}</strong><p>{stale?'当前版本已过期，不能覆盖其他页面的新设置。':s.desired!=='paused'?'先暂停 Human，再保存连接范围。暂停期间消息会排队。':'保存后仍保持暂停；可从右上角恢复运行。'}</p></div><div className="hn-row"><Button disabled={busy} onClick={onRefresh}>核对最新版本</Button>{dirty&&<Button onClick={section.reset}>放弃修改</Button>}{s.desired!=='paused'&&<Button disabled={busy||s.agentBusy} onClick={()=>api.run(()=>api.control({op:'pause'}),'已暂停，连接设置草稿已保留')}>暂停以便保存</Button>}<Button primary disabled={busy||readError||s.agentBusy||s.desired!=='paused'||stale||!dirty} onClick={save}>保存工具与连接</Button></div></div>
  </>;
}

export default function CapabilitySettings({api,s,busy,ui}:any){
  const {ReadState,useRead}=ui,[nonce,setNonce]=useState(0),result=useRead(api,{kind:'capability-settings'},nonce),[loaded,setLoaded]=useState<any>(null);
  useEffect(()=>{if(result.data&&!result.error)setLoaded(result.data);},[result.data,result.error]);
  return loaded?<>{result.error&&<ui.Band>读取最新配置失败：{result.error}。本地草稿已保留。</ui.Band>}<CapabilityForm api={api} s={s} busy={busy||result.loading} readError={result.error} ui={ui} server={loaded} onRefresh={()=>setNonce(value=>value+1)}/></>:<ReadState result={result}>{()=>null}</ReadState>;
}
