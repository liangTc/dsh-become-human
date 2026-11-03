import React,{useState} from 'react';
import {sourceStatusView} from './extension-config.mjs';
const date=(value:any)=>value?new Date(value).toLocaleString():'尚无记录';
export function SourceConfig({editors,entries,onChange,ui}:any){
 const {Button,Field,Input,Select,Check,OptionalSection}=ui;
 return <>{editors.map((editor:any)=>{
  const entry=entries.find((n:any)=>n.id===editor.nodeId),config=entry?.config??{},rows=config.sources??[];
  if(!entry||!Array.isArray(rows)||rows.some((r:any)=>!r||typeof r!=='object'||Array.isArray(r)))return <p key={editor.nodeId} className="hn-error">来源结构无效，请在高级配置中修正。</p>;
  const change=(next:any)=>onChange(entries.map((n:any)=>n.id===entry.id?{...n,config:{...config,...next}}:n));
  const update=(index:number,value:any)=>change({sources:rows.map((r:any,i:number)=>i===index?{...r,...value}:r)});
  return <section key={editor.nodeId} aria-label="公开来源配置" className="hn-source-editor">
   <h4>公开来源</h4><p className="hn-note">只读取你填写的公开地址。读取本身不消耗模型额度，内容变化后是否采取行动仍由 Human 决定。</p>
   {rows.length===0&&<p>还没有来源，添加一个订阅或网页地址即可开始。</p>}
   {rows.map((row:any,i:number)=><div className="hn-source-card" key={row.id??i} aria-label={'来源 '+(i+1)}>
    <div className="hn-row"><strong>来源 {i+1}</strong><Check label={'启用来源 '+(i+1)} value={row.enabled!==false} onChange={(v:boolean)=>update(i,{enabled:v})}/><Button danger onClick={()=>change({sources:rows.filter((_:any,j:number)=>j!==i)})}>移除来源 {i+1}</Button></div>
    <div className="hn-fields"><Field label="名称"><Input aria-label={'来源名称 '+(i+1)} value={row.title} onChange={(v:string)=>update(i,{title:v})} maxLength={120}/></Field><Field label="检查间隔（分钟）" hint="1–1440 分钟；失败后会延后重试。"><Input aria-label={'检查间隔 '+(i+1)} type="number" min={1} max={1440} step="any" value={(row.intervalMs??600000)/60000} onChange={(v:number)=>update(i,{intervalMs:Math.round(v*60000)})}/></Field><Field label="公开地址" wide hint="RSS、Atom、JSON Feed 或公开网页，不填写令牌和登录链接。"><Input aria-label={'来源地址 '+(i+1)} value={row.url} onChange={(v:string)=>update(i,{url:v.trim()})} placeholder="https://…"/></Field></div>
    <OptionalSection title="来源高级选项"><Field label="内容格式"><Select aria-label={'内容格式 '+(i+1)} value={row.format??'auto'} onChange={(v:string)=>update(i,{format:v})} options={[["auto","自动识别"],["feed","订阅（RSS / Atom / JSON Feed）"],["document","普通网页 / 文本"]]}/></Field><Check label={'首次读取也提供当前内容 '+(i+1)} value={row.emitInitial??false} onChange={(v:boolean)=>update(i,{emitInitial:v})}/><p className="hn-help">默认首次只建立比对基线。修改来源配置会重新建立基线；开启首次提供时，可能再次提供现有条目。</p><small>来源标识：{row.id}</small></OptionalSection>
   </div>)}
   <Button disabled={rows.length>=8} onClick={()=>change({sources:[...rows,{id:'source.'+crypto.randomUUID(),title:'',url:'',intervalMs:600000,format:'auto',enabled:true,emitInitial:false}]})}>添加来源</Button>
   <Check label="允许模型分析来源变化" value={config.reviewWithModel??false} onChange={(v:boolean)=>change({reviewWithModel:v})}/><p className="hn-help">关闭时只记录观察；开启后，Human 选中此行为时可使用自主额度分析，不会因此自动发消息。</p>
  </section>;
 })}</>;
}
export function SourceStatuses({item,s,api,ui,busy}:any){
 const {Button,OptionalSection}=ui,[pending,setPending]=useState<string|null>(null),[error,setError]=useState('');
 const rows=(item.configEditors??[]).flatMap((e:any)=>{const n=item.nodes.find((n:any)=>n.id===e.nodeId);return Array.isArray(n?.config?.sources)?n.config.sources.map((r:any)=>({...r,enabled:!n.disabled&&r.enabled!==false})):[];});
 if(!rows.length)return null;
 const check=async(row:any,status:any)=>{setPending(row.id);setError('');try{await api.control({op:'public-source-check',source:row.id,fingerprint:status.fingerprint});}catch(e:any){const errors:any={SOURCE_CHECK_TOO_SOON:'刚刚已检查，请稍等一分钟。',SOURCE_CONFIGURATION_CHANGED:'来源配置已更新，请刷新后重试。',SOURCE_NOT_REGISTERED:'来源已停用或移除，请刷新后核对。'};setError(errors[e.message]??'未能提交检查，请核对后台状态后重试。');}finally{setPending(null);}};
 return <div className="hn-source-statuses" aria-label="来源读取状态">{error&&<p role="alert" className="hn-error">{error}</p>}{rows.map((row:any)=>{
  const status=s?.publicSources?.find((r:any)=>r.source===row.id&&r.url===row.url),view=sourceStatusView(status,{enabled:row.enabled});
  return <div className="hn-source-card" key={row.id}><div className="hn-row"><strong>{row.title||'未命名来源'}</strong><span className="hn-tag">{view.title}</span><Button disabled={busy||!!pending||!row.enabled||!status||status.checking||status.manualCheckAvailableAt>Date.now()} onClick={()=>void check(row,status)}>{pending===row.id?'正在提交…':'立即检查'}</Button></div><p className="hn-note">{view.hint}</p><div className="hn-source-dates"><span>最近成功：{date(status?.lastSuccess)}</span><span>下次检查：{row.enabled&&status?.nextAt?date(status.nextAt):'—'}</span></div><OptionalSection title="读取详情"><p className="hn-help">{row.url}</p><p>最近尝试：{date(status?.lastCheck)} · 已识别 {status?.knownItems??0} 个条目 · 待接收 {status?.pendingItems??0} 条</p>{status?.lastError&&<p className="hn-error">{status.lastError}</p>}{status?.diagnostic&&<pre>{JSON.stringify(status.diagnostic,null,2)}</pre>}<p className="hn-help">这是已保存配置的状态；编辑中的变更需要保存后才生效。手动检查每个来源最多每分钟一次。</p></OptionalSection></div>;
 })}</div>;
}
