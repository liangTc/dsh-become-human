import React,{useEffect,useRef,useState} from 'react';
import {useDraftGuard} from './native-shell';

const defaults={enabled:false,intervalMs:600000,retentionDays:14,maxSessionsPerCheck:3,maxMessagesPerSession:20};
const categoryLabels:any={progress:'进展线索',decision:'决策线索',blocker:'阻塞线索',todo:'待办线索'};
const statusLabels:any={active:'可用于当前工作',forgotten:'已忘记',invalid:'依据已失效',expired:'已到期',withdrawn:'读取授权已撤回',superseded:'已有更新记录',corrected:'附有主人批注'};
const clock=(value:any)=>Number.isFinite(value)&&value>0?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
const annotationOf=(row:any)=>typeof row.annotation==='string'?row.annotation:row.annotation?.text??row.annotation?.summary??'';
const rowsOf=(data:any)=>Array.isArray(data?.memories)?data.memories:Array.isArray(data?.memories?.items)?data.memories.items:[];
const settingsOf=(data:any)=>({...defaults,...(data?.settings??{})});
const draftOf=(settings:any)=>({enabled:settings.enabled===true,intervalMinutes:String(settings.intervalMs/60000),retentionDays:String(settings.retentionDays),maxSessionsPerCheck:String(settings.maxSessionsPerCheck),maxMessagesPerSession:String(settings.maxMessagesPerSession)});
function numeric(value:string,min:number,max:number,label:string){const n=Number(value);if(!value.trim()||!Number.isSafeInteger(n)||n<min||n>max)throw new Error(label+'需填写 '+min+'–'+max+' 之间的整数。');return n;}
function payloadOf(draft:any){return {enabled:draft.enabled,intervalMs:numeric(draft.intervalMinutes,5,1440,'检查间隔')*60000,retentionDays:numeric(draft.retentionDays,1,90,'保留天数'),maxSessionsPerCheck:numeric(draft.maxSessionsPerCheck,1,5,'每次最多会话数'),maxMessagesPerSession:numeric(draft.maxMessagesPerSession,5,30,'每个会话消息数')};}
const inScope=(bridge:any,row:any)=>bridge?.sessionReadEnabled===true&&(bridge.sessionReadScope==='all'||(bridge.allowedSessionIds??[]).includes(row.sessionId));

function WorkMemory({api,s,busy,ui,row,visible,authorized,onChanged}:any){
  const {Button,Text,Detail,Field}=ui;
  const [base,setBase]=useState(()=>({version:row.version,annotation:annotationOf(row)})),[annotation,setAnnotation]=useState(()=>annotationOf(row)),[editing,setEditing]=useState(false),[forget,setForget]=useState(false),[locallyForgotten,setLocallyForgotten]=useState(false);
  const active=authorized&&!locallyForgotten&&row.valid!==false&&!['forgotten','invalid','expired','withdrawn','superseded'].includes(row.status),valid=visible&&active,dirty=active&&annotation!==base.annotation,stale=row.version!==base.version;
  useDraftGuard(dirty);
  useEffect(()=>{
    if(!active){setBase({version:row.version,annotation:''});setAnnotation('');setEditing(false);setForget(false);return;}
    if(!dirty){setBase({version:row.version,annotation:annotationOf(row)});setAnnotation(annotationOf(row));}
  },[row,active]);
  const locked=busy||s.agentBusy||s.desired!=='paused',sourceRole=row.role==='user'?'该会话用户原话':row.role==='assistant'?'其他 Agent 回复／建议':'来源角色未记录';
  const save=()=>api.run(async()=>{
    if(!valid||stale||locked)throw new Error('请先暂停 Human 并核对这条工作记忆的最新版本。');
    await api.control({op:'work-observation-annotate',sessionId:s.sessionId,id:row.id,expectedVersion:base.version,annotation});
    const fresh=await onChanged(),next=rowsOf(fresh).find((item:any)=>item.id===row.id);
    if(next){setBase({version:next.version,annotation:annotationOf(next)});setAnnotation(annotationOf(next));}
    setEditing(false);
  },'批注已保存；原会话摘录未改写，Human 仍保持暂停');
  return <details className="hn-group">
    <summary>{categoryLabels[row.category]??'工作线索'} · {valid?(row.role==='assistant'?'Agent 建议':'会话原话'):!visible?'正在核对':(statusLabels[row.status]??'当前不可用')}{valid?' · '+clock(row.observedAt??row.created):''}</summary>
    {valid?<><p className="hn-note" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row.text??''}</p><p className="hn-help">{sourceRole}。分类由模型判断，摘录不证明事情已完成，也不代表主人在 Human 主会话中确认。</p>
      {annotationOf(row)?<div className="hn-note"><strong>主人批注</strong><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{annotationOf(row)}</p><small>批注与会话原文分开保存，不充当外部证据。</small></div>:null}
      <details className="hn-advanced"><summary>查看来源与有效范围</summary><p className="hn-help" style={{overflowWrap:'anywhere'}}>DSH 会话：{row.sessionId??'未记录'}<br/>消息序号：{row.seq??'未记录'}<br/>原始角色：{sourceRole}<br/>状态：{statusLabels[row.status]??row.status??'未记录'}{row.expiresAt?<><br/>保留至：{clock(row.expiresAt)}</>:null}</p>{row.partial||row.truncated?<p className="hn-help">这条来源只包含部分内容，不能据此判断完整会话。</p>:null}</details>
    </>:<p className="hn-help">{!visible?'正在核对当前授权与记录，旧内容暂不展示。':'这条工作记忆当前不参与召回。读取授权、观察开关、保留期限或来源发生变化后，旧内容不会继续展示给模型。'}</p>}
    <div className="hn-row">{valid?<Button disabled={locked} onClick={()=>setEditing(value=>!value)}>{editing?'收起批注编辑':'添加或修改批注'}</Button>:null}<Button danger disabled={locked||dirty||row.status==='forgotten'} onClick={()=>setForget(true)}>忘记这条工作记忆</Button></div>
    {editing&&valid?<><Field label="主人批注" hint="最多 1,000 字。用于纠正或补充工作线索；会话原文与分类依据仍单独保留。"><Text aria-label="工作记忆批注" value={annotation} maxLength={1000} rows={3} disabled={locked} onChange={setAnnotation}/></Field>{stale?<p className="hn-help">这条记录已更新，当前批注草稿保留。放弃草稿后可查看最新版本。</p>:null}<div className="hn-row"><Button disabled={locked||!dirty||stale} onClick={save}>保存工作批注</Button><Button disabled={busy} onClick={()=>{setBase({version:row.version,annotation:annotationOf(row)});setAnnotation(annotationOf(row));setEditing(false);}}>放弃批注修改</Button></div></>:null}
    {forget?<Detail title="忘记这条工作记忆" onClose={()=>setForget(false)}><p>忘记后，这条摘录与批注不再参与工作协助，同一来源版本不会再次自动导入。原 DSH 会话不会被删除。</p><div className="hn-row"><Button danger disabled={locked} onClick={()=>api.run(async()=>{await api.control({op:'work-observation-forget',sessionId:s.sessionId,id:row.id,expectedVersion:row.version});setLocallyForgotten(true);setForget(false);await onChanged();},'工作记忆已忘记，原 DSH 会话保持不变')}>确认忘记工作记忆</Button><Button disabled={busy} onClick={()=>setForget(false)}>保留</Button></div></Detail>:null}
  </details>;
}

function ObservationForm({api,s,busy,ui,data,bridge,connectionDraft,connectionStale,onChanged,readError,visible}:any){
  const {Button,Check,Field,Band,JsonDetails}=ui,settings=settingsOf(data),status=data.status??{};
  const [base,setBase]=useState(()=>({revision:settings.revision??0,draft:draftOf(settings)})),[draft,setDraft]=useState(()=>draftOf(settings));
  const dirty=JSON.stringify(draft)!==JSON.stringify(base.draft),stale=(settings.revision??0)!==base.revision;
  useDraftGuard(dirty);
  useEffect(()=>{if(!dirty){const fresh=settingsOf(data);setBase({revision:fresh.revision??0,draft:draftOf(fresh)});setDraft(draftOf(fresh));}},[data.settings]);
  const patch=(key:string,value:any)=>setDraft(previous=>({...previous,[key]:value}));
  const canRead=bridge?.sessionReadEnabled===true&&(bridge.sessionReadScope==='all'||(bridge.allowedSessionIds??[]).length>0),locked=busy||s.agentBusy||s.desired!=='paused',blocked=locked||!!readError||connectionDraft||connectionStale||stale;
  const save=()=>api.run(async()=>{
    if(blocked)throw new Error('请先暂停 Human，处理未保存的工具授权并核对最新设置。');
    await api.control({op:'work-observation-configure',sessionId:s.sessionId,expectedRevision:base.revision,settings:payloadOf(draft)});
    const fresh=settingsOf(await onChanged());setBase({revision:fresh.revision??0,draft:draftOf(fresh)});setDraft(draftOf(fresh));
  },'工作观察设置已保存，Human 仍保持暂停');
  const queued=status.requested===true||status.checkRequested===true||status.manualRequested===true,held=status.held===true;
  const stateLabel=!settings.enabled?'未开启工作观察':!canRead?'等待读取授权':held?'等待处理上次检查':status.running||['running','reading','extracting'].includes(status.phase)?'正在检查':queued?'已安排，恢复运行后检查':s.desired!=='running'||s.autonomy?.paused?'随 Human 暂停':'按周期检查';
  const records=rowsOf(data),total=data.memories?.total??records.length;
  return <>
    <h5 className="hn-section-title">工作观察与工作记忆</h5>
    <div className="hn-setting-summary"><span>{stateLabel}</span><span>已保存的读取范围：{!bridge?.sessionReadEnabled?'未授权':bridge.sessionReadScope==='all'?'全部可见普通会话':'指定 '+(bridge.allowedSessionIds??[]).length+' 个会话'}</span></div>
    <p className="hn-help">在读取授权内，定期从其他 DSH 会话提炼进展、决策、阻塞和待办，帮助当前 Human 了解工作上下文。它只读文本，不启动目标 Agent，不发送任务，也不会自动把工作报告推送到聊天。</p>
    {!canRead?<Band>当前没有可读取的会话范围。你可以先保存工作观察偏好，再在上方授权读取；开启观察不会自动扩大读取权限。</Band>:null}
    <Check label="开启工作观察并沉淀为工作记忆" disabled={busy||!!readError} value={draft.enabled} onChange={(value:boolean)=>patch('enabled',value)}/>
    <div className="hn-fields">
      <Field label="检查间隔 · 分钟" hint="5–1,440 分钟。到期后随自主唤醒安排，实际不会快于自主检查频率，也不抢占主人聊天。"><input className="hn-input" type="number" aria-label="工作观察检查间隔 · 分钟" min={5} max={1440} step={1} disabled={busy||!draft.enabled} value={draft.intervalMinutes} onChange={event=>patch('intervalMinutes',event.target.value)}/></Field>
      <Field label="工作记忆保留 · 天" hint="1–90 天，表示召回有效期。到期后不再参与召回，不代表清理历史审计或离线备份。"><input className="hn-input" type="number" aria-label="工作记忆保留天数" min={1} max={90} step={1} disabled={busy||!draft.enabled} value={draft.retentionDays} onChange={event=>patch('retentionDays',event.target.value)}/></Field>
      <Field label="每次最多检查会话数" hint="1–5 个。会话较多时轮流检查，不在一轮读取全部历史。"><input className="hn-input" type="number" aria-label="工作观察每次最多会话数" min={1} max={5} step={1} disabled={busy||!draft.enabled} value={draft.maxSessionsPerCheck} onChange={event=>patch('maxSessionsPerCheck',event.target.value)}/></Field>
      <Field label="每个会话最多读取消息数" hint="5–30 条。首次只取最近有限消息，后续增量读取新内容。"><input className="hn-input" type="number" aria-label="工作观察每会话消息数" min={5} max={30} step={1} disabled={busy||!draft.enabled} value={draft.maxMessagesPerSession} onChange={event=>patch('maxMessagesPerSession',event.target.value)}/></Field>
    </div>
    <p className="hn-help">无新增内容时不调用提炼模型；有变化时使用自主额度。用户原话和其他 Agent 的建议分开保存，分类是模型推断，不等于主人确认或实际完成；工作记忆不混入主人个人事实或人格证据。关闭观察或撤回读取授权后，不再向模型召回这些内容。</p>
    {connectionDraft||connectionStale?<Band>上方工具与连接存在未保存或过期的授权草稿。这里展示的是已保存范围；请先处理该草稿，再保存观察设置或安排检查。</Band>:null}
    {stale?<Band>工作观察设置已在其他页面更新。当前草稿已保留，请放弃修改并基于最新设置编辑。</Band>:null}
    <div className="hn-row">{s.desired!=='paused'?<Button disabled={busy||s.agentBusy} onClick={()=>api.run(()=>api.control({op:'pause',sessionId:s.sessionId}),'已暂停，工作观察草稿已保留')}>暂停以便保存工作观察</Button>:null}<Button primary disabled={blocked||!dirty} onClick={save}>保存工作观察</Button>{dirty?<Button disabled={busy} onClick={()=>{setBase({revision:settings.revision??0,draft:draftOf(settings)});setDraft(draftOf(settings));}}>放弃观察设置修改</Button>:null}</div>
    <p className="hn-help">保存、批注和忘记均需暂停 Human；操作后不会自动恢复。未保存的设置不会改变当前观察行为。</p>
    <details className="hn-advanced"><summary>检查状态与手动安排</summary>
      <div className="hn-setting-summary"><span>上次检查：{clock(status.lastCheckedAt)}</span><span>下次可检查：{clock(status.nextCheckAt??status.nextEligibleAt)}</span></div>
      {status.lastError?<Band>上次检查未完成，记录已保留。处理原因后，可在暂停时明确允许重新检查。</Band>:null}
      <p className="hn-help">手动安排只排队一次检查，恢复 Human 后才执行，仍受读取授权、自主额度和单一执行线约束。失败批次不会自动反复重试。</p>
      <div className="hn-row"><Button disabled={blocked||dirty||!settings.enabled||!canRead||queued||held} onClick={()=>api.run(async()=>{await api.control({op:'work-observation-check',sessionId:s.sessionId});await onChanged();},'已安排一次工作检查，恢复 Human 后执行')}>安排一次工作检查</Button>{held?<Button disabled={blocked||dirty||!settings.enabled||!canRead} onClick={()=>api.run(async()=>{await api.control({op:'work-observation-retry',sessionId:s.sessionId});await onChanged();},'已允许重新检查失败批次，仍保持暂停')}>允许重新检查失败批次</Button>:null}<Button disabled={busy} onClick={()=>api.run(onChanged,'工作观察状态已刷新')}>刷新工作观察状态</Button></div>
      <JsonDetails label="查看检查诊断" value={{lastError:status.lastError??null,held,phase:status.phase??null,lastCheckedAt:status.lastCheckedAt??null,nextCheckAt:status.nextCheckAt??status.nextEligibleAt??null}}/>
    </details>
    <details className="hn-advanced"><summary>工作记忆 · {total} 条</summary>
      <p className="hn-help">先查看需要的记录，再展开出处或添加批注。忘记只影响 Human 的工作记忆，原 DSH 会话保持不变。</p>
      {!visible?<p className="hn-help">正在核对当前读取范围与记录，旧内容暂不展示。</p>:null}
      {records.length?records.map((row:any)=><WorkMemory key={row.id} api={api} s={s} busy={busy||dirty} ui={ui} row={row} visible={visible} authorized={inScope(bridge,row)&&settings.enabled} onChanged={onChanged}/>):visible?<p className="hn-note">尚无工作记忆。开启观察、授权会话并恢复运行后，只有实际提炼到的有效内容才会出现在这里。</p>:null}
    </details>
  </>;
}

export default function WorkObservation({api,s,busy,ui,bridge,connectionDraft=false,connectionStale=false}:any){
  const {Button,Band}=ui,[offset,setOffset]=useState(0),[nonce,setNonce]=useState(0),[loaded,setLoaded]=useState<any>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const authority=JSON.stringify([s.sessionId,bridge?.sessionReadEnabled,bridge?.sessionReadScope,bridge?.allowedSessionIds??[],s.management?.capabilityRevision,s.workObservation?.revision,s.workObservation?.settingsRevision]);
  const requestKey=JSON.stringify([authority,offset,nonce]),latest=useRef(requestKey);latest.current=requestKey;
  useEffect(()=>{let live=true;setLoading(true);setError('');api.read({kind:'work-observation',limit:20,offset}).then((data:any)=>{if(live&&latest.current===requestKey){setLoaded({data,authority});setLoading(false);}},(cause:any)=>{if(live&&latest.current===requestKey){setError(String(cause?.message??cause));setLoading(false);}});return ()=>{live=false;};},[requestKey]);
  const refresh=async()=>{const key=latest.current,[currentAuthority,currentOffset]=JSON.parse(key),data=await api.read({kind:'work-observation',limit:20,offset:currentOffset});if(latest.current===key){setLoaded({data,authority:currentAuthority});setError('');setLoading(false);}return data;};
  const data=loaded?.data,total=data?.memories?.total??rowsOf(data).length,hasMore=data?.memories?.hasMore===true;
  return <section className="hn-form-section" aria-label="工作观察与工作记忆">
    {error?<Band>读取工作观察失败：{error}。当前草稿保留，旧记忆内容暂不展示。<Button disabled={busy||loading} onClick={()=>setNonce(value=>value+1)}>重新读取工作观察</Button></Band>:null}
    {data?<ObservationForm api={api} s={s} busy={busy||loading} ui={ui} data={data} bridge={bridge} connectionDraft={connectionDraft} connectionStale={connectionStale} onChanged={refresh} readError={error} visible={!loading&&!error&&loaded.authority===authority}/>:!error?<p className="hn-help">正在读取工作观察设置…</p>:null}
    {data&&(total>20||offset>0)?<div className="hn-row"><span className="hn-help">工作记忆第 {Math.floor(offset/20)+1} 页 · 共 {total} 条</span><Button disabled={busy||loading||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-20))}>上一页工作记忆</Button><Button disabled={busy||loading||!hasMore} onClick={()=>setOffset(value=>value+20)}>下一页工作记忆</Button></div>:null}
  </section>;
}
