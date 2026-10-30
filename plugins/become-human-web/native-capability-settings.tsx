import React,{useEffect,useState} from 'react';
import {useDraftGuard,useSectionContext,OptionalSection,pauseForConfiguration} from './native-shell';
import McpConnections,{draftMcpServers,serializeMcpServers} from './native-mcp-settings';
import WorkObservation from './native-work-observation';

function settingsOf(value:any){const result=structuredClone(value?.settings??value??{});delete result.revision;if(result.bridge)delete result.bridge.browser;return result;}
function draftOf(value:any){const settings=settingsOf(value);return {settings,mcpRows:draftMcpServers(settings.mcp?.servers??[]),sessionIds:(settings.bridge?.allowedSessionIds??[]).join('\n')};}
const split=(text:string)=>Array.from(new Set(text.split(/[\r\n,，]+/).map(item=>item.trim()).filter(Boolean)));

function CapabilityForm({api,s,busy,ui,server,onRefresh,readError}:any){
  const {Button,Field,Input,Text,Select,Check,Band,JsonDetails}=ui,section=useSectionContext();
  const [base,setBase]=useState(()=>({revision:server.revision??0,draft:draftOf(server)})),[draft,setDraft]=useState(()=>draftOf(server));
  const dirty=JSON.stringify(draft)!==JSON.stringify(base.draft),stale=(server.revision??0)!==base.revision;
  useDraftGuard(dirty);
  useEffect(()=>{if(!dirty){const next=draftOf(server);setBase({revision:server.revision??0,draft:next});setDraft(next);}},[server]);
  const settings=draft.settings,bridge=settings.bridge??{},mcp=settings.mcp??{};
  const patchBridge=(key:string,value:any)=>setDraft(previous=>({...previous,settings:{...previous.settings,bridge:{...previous.settings.bridge,[key]:value}}}));
  const acceptFresh=async()=>{
    const fresh=await api.read({kind:'capability-settings'}),value=draftOf(fresh);setBase({revision:fresh.revision??0,draft:value});setDraft(value);onRefresh();
  };
  const grantSessions=(mode:'read'|'use'|'selected')=>api.run(async()=>{
    if(dirty||stale||readError)throw new Error('请先保存或放弃草稿，再使用一键授权。');
    if(s.desired!=='paused')await api.control({op:'pause',sessionId:s.sessionId});
    const next=settingsOf(server),current=next.bridge??{};
    next.bridge=mode==='selected'?{...current,sessionReadScope:'selected',sessionWriteScope:'selected'}:{...current,sessionReadEnabled:true,sessionReadScope:'all',...(mode==='use'?{sessionWriteEnabled:true,sessionWriteScope:'all'}:{})};
    await api.control({op:'capability-configure',sessionId:s.sessionId,expectedRevision:base.revision,settings:next});await acceptFresh();
  },mode==='selected'?'已退回指定会话范围，Human 保持暂停':mode==='read'?'已授权读取全部普通会话，Human 保持暂停':'已授权使用全部普通会话，写操作仍需逐笔批准；Human 保持暂停');
  const save=()=>api.run(async()=>{
    const next={...draft.settings,mcp:{...mcp,servers:serializeMcpServers(draft.mcpRows)},bridge:{...bridge,allowedSessionIds:split(draft.sessionIds)}};
    await pauseForConfiguration(api);await api.control({op:'capability-configure',sessionId:s.sessionId,expectedRevision:base.revision,settings:next});
    await acceptFresh();
  },'工具与连接设置已保存，Human 仍保持暂停');
  return <><h3>工具与连接</h3><Band>连接范围仅作用于当前 Human。读取和写入分别开启；写操作仍需逐笔批准。其他 DSH 会话作为外部资料或执行目标，不改变 Human 的唯一主会话。</Band>
    <section className="hn-form-section"><h4 className="hn-section-heading">MCP 服务</h4><Check label="启用内置只读 MCP 服务" disabled={busy} value={mcp.bundledEnabled!==false} onChange={(enabled:boolean)=>setDraft(previous=>({...previous,settings:{...previous.settings,mcp:{...previous.settings.mcp,bundledEnabled:enabled}}}))}/><p className="hn-help">内置服务提供公开网页读取。自定义服务可连接你已准备好的本地程序或远程 MCP 端点；可用工具统一出现在“任务 → 工具与能力”。</p><McpConnections api={api} s={s} ui={ui} busy={busy||stale||!!readError} rows={draft.mcpRows} onChange={(mcpRows:any[])=>setDraft(previous=>({...previous,mcpRows}))} expectedRevision={base.revision}/></section>
    <section className="hn-form-section"><h4 className="hn-section-heading">DSH 会话</h4>
      <div className="hn-setting-summary"><span>读取：{!bridge.sessionReadEnabled?'未开启':bridge.sessionReadScope==='all'?'全部普通会话':'指定会话'}</span><span>使用：{!bridge.sessionWriteEnabled?'未开启':bridge.sessionWriteScope==='all'?'全部普通会话 · 逐笔批准':'指定会话 · 逐笔批准'}</span></div>
      <p className="hn-help">“全部”涵盖当前 DSH 宿主可见的普通会话，以及后续新增的普通会话；不包含 Human 主会话、子 Agent 或其他宿主的数据。</p>
      <div className="hn-row"><Button disabled={busy||readError||dirty||stale} onClick={()=>grantSessions('read')}>一键授权读取全部会话</Button><Button disabled={busy||readError||dirty||stale} onClick={()=>grantSessions('use')}>一键授权使用全部会话</Button>{(bridge.sessionReadScope==='all'||bridge.sessionWriteScope==='all')&&<Button disabled={busy||readError||dirty||stale} onClick={()=>grantSessions('selected')}>收回全部会话授权</Button>}</div>
      <p className="hn-help">一键操作会先暂停 Human 并立即保存这一项授权，完成后保持暂停。读取授权不增加写入范围；使用授权允许发送任务和请求取消，但每笔操作仍要核对目标、参数并批准。其他会话的模型调用由目标会话计费与运行。{dirty?' 当前有未保存草稿，请先保存或放弃草稿。':''}</p>
      <details className="hn-advanced"><summary>自行配置读取、使用与指定会话</summary><div className="hn-fields">
        <div><Check label="开启会话读取" disabled={busy} value={bridge.sessionReadEnabled} onChange={(enabled:boolean)=>patchBridge('sessionReadEnabled',enabled)}/><Field label="读取范围" hint="允许读取可见聊天文本；不会因读取而启动目标 Agent。"><Select aria-label="DSH 会话读取范围" disabled={busy||!bridge.sessionReadEnabled} value={bridge.sessionReadScope??'selected'} options={[["selected","仅指定会话"],["all","全部可见普通会话，含后续新增"]]} onChange={(scope:string)=>patchBridge('sessionReadScope',scope)}/></Field></div>
        <div><Check label="开启会话使用" disabled={busy} value={bridge.sessionWriteEnabled} onChange={(enabled:boolean)=>patchBridge('sessionWriteEnabled',enabled)}/><Field label="使用范围" hint="允许将其他会话作为任务执行目标；发送和取消均须逐笔批准。"><Select aria-label="DSH 会话使用范围" disabled={busy||!bridge.sessionWriteEnabled} value={bridge.sessionWriteScope??'selected'} options={[["selected","仅指定会话"],["all","全部可见普通会话，含后续新增"]]} onChange={(scope:string)=>patchBridge('sessionWriteScope',scope)}/></Field></div>
        <Field wide label="指定会话 ID · 每行一个" hint="仅在范围选择“仅指定会话”时使用。留空不授权任何指定会话；不填写 Human 主会话编号。"><Text value={draft.sessionIds} rows={4} disabled={busy} placeholder="粘贴需要访问的 DSH 会话 ID" onChange={(sessionIds:string)=>setDraft(previous=>({...previous,sessionIds}))}/></Field>
      </div></details>
      <OptionalSection title="定期观察工作会话"><WorkObservation api={api} s={s} busy={busy} ui={ui} bridge={settingsOf(server).bridge} connectionDraft={dirty} connectionStale={stale}/></OptionalSection>
    </section>
    {stale&&<Band>连接设置已被其他页面修改，当前草稿已保留。请放弃草稿并重新打开此分类，再基于最新范围修改。</Band>}
    <div className="hn-save"><div><strong>{dirty?'有未保存的连接设置':'设置仅作用于当前 Human'}</strong><p>{stale?'当前版本已过期，不能覆盖其他页面的新设置。':s.desired!=='paused'?'保存时会先暂停，完成后由你恢复运行。':'保存后仍保持暂停；可从右上角恢复运行。'}</p></div><div className="hn-row"><Button disabled={busy} onClick={onRefresh}>核对最新版本</Button>{dirty&&<Button onClick={section.reset}>放弃修改</Button>}<Button primary disabled={busy||readError||stale||!dirty} onClick={save}>{s.desired==='running'?'暂停并保存':'保存工具与连接'}</Button></div></div>
  </>;
}

export default function CapabilitySettings({api,s,busy,ui}:any){
  const {ReadState,useRead}=ui,[nonce,setNonce]=useState(0),result=useRead(api,{kind:'capability-settings'},nonce),[loaded,setLoaded]=useState<any>(null);
  useEffect(()=>{if(result.data&&!result.error)setLoaded(result.data);},[result.data,result.error]);
  return loaded?<>{result.error&&<ui.Band>读取最新配置失败：{result.error}。本地草稿已保留。</ui.Band>}<CapabilityForm api={api} s={s} busy={busy||result.loading} readError={result.error} ui={ui} server={loaded} onRefresh={()=>setNonce(value=>value+1)}/></>:<ReadState result={result}>{()=>null}</ReadState>;
}
