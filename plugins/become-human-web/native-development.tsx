import React,{useEffect,useState} from 'react';
import {useDraftGuard,useDraftNavigation} from './native-shell';
import {useRetainedRead} from './native-disclosure';

const clock=(value:any)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
const kindLabels:any={interest:'兴趣',disposition:'性格倾向',habit:'习惯',value:'价值倾向',relationship:'相处倾向',expression:'表达习惯',behavior:'行为倾向'};
const statusLabels:any={active:'当前生效',observing:'继续观察',invalid:'依据已失效',reverted:'已撤回',pending:'等待整理',prepared:'等待整理',running:'正在整理',completed:'已整理',restored:'已恢复',failed:'未完成',cancelled:'已取消'};
const reasonLabels:any={'independent-evidence-needed':'还需要更多独立经历作为依据','longer-observation-needed':'还需要更长时间的观察','confidence-below-threshold':'当前判断还不够确定','new-independent-evidence-needed':'还需要新的独立经历，重复引用不会推动变化','no-material-change':'与已有倾向接近，暂不新增变化','trait-capacity-reached':'当前偏移结果已达到上限，先保留观察','evidence-withdrawn-expired-or-revised':'关联依据已撤回、到期或修订','owner-reverted-single-change':'已由主人撤回'};
const label=(value:any)=>statusLabels[value]??value??'未知';

function SettingsNotice({s,ui}:any){const {Band}=ui;return s.desired!=='paused'||s.agentBusy?<Band>请先在右上角暂停 Human，等待当前执行结束后保存设置或撤回记录。未保存的修改会保留。</Band>:<p className="hn-help">保存后仍保持暂停。准备好时可在右上角恢复；整理和人格回顾共用自主额度与唯一执行线。</p>;}
function Evidence({refs,evidence,ui}:any){const {JsonDetails}=ui;return <JsonDetails label="查看依据与原记录编号" value={{refs:refs??[],evidence:evidence??[]}}/>;}

export function ReviewStatus({api,s,busy,ui,runtime,dirty=false,onChanged}:any){
  const {Button}=ui,navigation=useDraftNavigation(),job=runtime?.job,hasDraft=dirty||navigation?.dirty;
  const states:any={ready:'等待安排',running:'正在回顾经历',suspended:'已保存进度','waiting-budget':'等待自主额度',completed:'回顾完成',failed:'回顾失败',interrupted:'上次回顾中断','retry-approved':'已允许重新安排',cancelled:'本次回顾已取消'};
  if(!job)return <p className="hn-note">经历回顾尚未安排，满足条件后由正常自主调度检查。</p>;
  const retryable=['failed','interrupted'].includes(job.status),locked=busy||s.agentBusy||s.desired!=='paused'||hasDraft;
  const hint=job.status==='waiting-budget'?'等待自主额度或授权；恢复后会重新核对来源与预算，不绕过准入限制。':job.status==='suspended'?'当前进度已保留；主人聊天或暂停结束并恢复运行后，按原调度重新核对来源与额度。':retryable?'这次回顾不会自动重试。暂停并处理未保存的设置后，可明确允许重新安排。':job.status==='retry-approved'?'许可已保存，仍保持暂停。恢复 Human 后才按调度重新核对来源、预留自主额度并执行。':job.status==='cancelled'?'设置或相关条件已变化，本次未继续；后续仅按当前有效设置重新判断。':job.status==='completed'?'结果已记录；没有充分依据时，可以不新增摘要或人格变化。':'记忆整理与人格偏移共用这次回顾，不会另开思考线。';
  return <section className="hn-group" aria-label="经历回顾状态"><div className="hn-row hn-between"><strong>{states[job.status]??'回顾状态待核对'}</strong><span className="hn-note">{clock(job.updated)}</span></div><p className="hn-help">{hint}</p>{retryable&&job.error&&<p role="status">{ui.errorText?.(job.error)??job.error}</p>}{job.status==='waiting-budget'&&Number.isFinite(job.neededTokens)&&<p className="hn-note">本次预计需要预留 {job.neededTokens.toLocaleString('zh-CN')} token。预留值不等于供应商实际用量。</p>}{job.status==='completed'&&<p className="hn-note">新增摘要 {job.summaryId?1:0} 份 · 生效人格变化 {job.personaChanges??0} 项</p>}{retryable&&<><Button disabled={locked} onClick={()=>api.run(async()=>{await api.control({op:'development-review-retry',jobId:job.id});onChanged();},'已允许重新安排回顾，仍保持暂停；恢复后按调度执行')}>允许重新安排回顾</Button>{hasDraft&&<p className="hn-note">请先保存或放弃当前页面的草稿，再允许重新安排。</p>}</>}<details><summary>回顾编号与执行边界</summary><p className="hn-mono">{job.id}</p><p className="hn-note">模型请求计入自主额度；与聊天、学习共用唯一执行线。重新安排不立即调用模型。</p></details></section>;
}

function PersonaContents({api,s,busy,ui,data,onChanged}:any){
  const {Button,Check,Band,Empty,Detail,JsonDetails}=ui;
  const [baseline,setBaseline]=useState(data.settings),[enabled,setEnabled]=useState(data.settings.enabled),[confirm,setConfirm]=useState<any>(null);
  const dirty=enabled!==baseline.enabled,stale=data.settings.version!==baseline.version,locked=busy||s.agentBusy||s.desired!=='paused';
  useDraftGuard(dirty);
  useEffect(()=>{if(!dirty&&data.settings.version!==baseline.version){setBaseline(data.settings);setEnabled(data.settings.enabled);}},[data.settings,baseline.version,dirty]);
  const save=()=>api.run(async()=>{await api.control({op:'persona-development-configure',settings:{enabled},expectedVersion:baseline.version});const fresh=await api.read({kind:'persona-development'});setBaseline(fresh.settings);setEnabled(fresh.settings.enabled);onChanged();},'人格偏移设置已保存');
  const rows=data.history??[],traits=data.currentTraits??[],pending=data.pending??[];
  return <section className="hn-form-section" aria-label="人格偏移">
    <div className="hn-row hn-between"><h3>人格偏移</h3><Button disabled={busy} onClick={onChanged}>刷新偏移结果</Button></div>
    <p className="hn-help">基于持久记忆、真实交流和学习经历，逐渐形成兴趣、习惯与行为倾向。结果独立保存，可以查看原因、追溯证据并逐条撤回。</p>
    <Check label="开启人格偏移" disabled={busy} value={enabled} onChange={setEnabled}/>
    <p className="hn-help">{enabled?'恢复运行后，按调度回顾有效经历；证据不足的变化继续观察。':'关闭后不再自动形成或使用偏移；已有结果与历史保留。'}姓名、基础角色与权限仍由你配置。</p>
    <SettingsNotice {...{s,ui}}/>
    {stale&&<Band>偏移设置已在其他页面修改。当前草稿保留，请先核对最新设置再保存。</Band>}
    <div className="hn-row"><Button primary disabled={locked||stale||!dirty} onClick={save}>保存人格偏移设置</Button>{dirty&&<Button onClick={()=>{setBaseline(data.settings);setEnabled(data.settings.enabled);}}>放弃此处修改并读取最新设置</Button>}</div>
    <ReviewStatus {...{api,s,busy,ui,dirty,onChanged}} runtime={data.runtime}/>
    <section className="hn-group"><h4 className="hn-section-heading">当前偏移结果 · {traits.length} 项</h4>
      {!data.settings.enabled&&traits.length>0&&<p className="hn-note">以下结果已保留，当前未参与人格上下文。</p>}
      {traits.length?traits.map((trait:any)=><article className="hn-line" key={trait.kind+':'+trait.key}><div className="hn-grow"><strong>{trait.label}</strong><p>{trait.description}</p><p className="hn-note">{kindLabels[trait.kind]??trait.kind} · 更新于 {clock(trait.lastChangedAt)}</p><Evidence refs={trait.refs} ui={ui}/></div></article>):<Empty>还没有生效的人格偏移。恢复运行后，会在有足够依据时逐步形成。</Empty>}
      <p className="hn-note">回顾周期约 {Math.round(data.settings.reviewIntervalMs/3600000)} 小时 · 最近回顾：{clock(data.settings.lastReviewedAt)} · 最近生效：{clock(data.settings.lastAppliedAt)}{pending.length?` · ${pending.length} 项继续观察`:''}</p>
    </section>
    <details className="hn-advanced"><summary>偏移历史与依据 · {rows.length} 条</summary>
      {rows.length?rows.map((change:any)=><details className="hn-group" key={change.id}><summary>{change.label} · {label(change.status)} · {clock(change.created)}</summary><p>{change.description}</p><p><strong>变化原因：</strong>{change.reason||'未提供'}</p>{change.statusReason&&<p className="hn-note">状态说明：{reasonLabels[change.statusReason]??change.statusReason}</p>}<p className="hn-note">{kindLabels[change.kind]??change.kind} · {change.revertedAt?'撤回于 '+clock(change.revertedAt):'尚未撤回'}</p><Evidence refs={change.refs} evidence={change.evidence} ui={ui}/><JsonDetails label="查看变化前后" value={{before:change.before,after:change.after,strength:change.strength,confidence:change.confidence}}/>{['active','observing'].includes(change.status)&&<div className="hn-row"><Button danger disabled={locked} onClick={()=>setConfirm({change,expectedVersion:data.version})}>{change.status==='observing'?'撤回这条观察':'撤回这条偏移'}</Button></div>}</details>):<Empty>有回顾结果后，变化记录会出现在这里。</Empty>}
    </details>
    {confirm&&<Detail title="撤回单条人格偏移" onClose={()=>setConfirm(null)}><p>撤回“{confirm.change.label}”？记录与原始依据仍会保留；其他偏移和基础人格配置不受影响。</p><div className="hn-row"><Button danger disabled={locked} onClick={()=>api.run(async()=>{await api.control({op:'persona-development-revert',changeId:confirm.change.id,expectedVersion:confirm.expectedVersion});setConfirm(null);onChanged();},'已撤回这条人格偏移')}>确认撤回</Button><Button onClick={()=>setConfirm(null)}>取消</Button></div></Detail>}
  </section>;
}

export function PersonaDevelopment({api,s,busy,ui}:any){
  const {Button,Band,Empty}=ui,[nonce,setNonce]=useState(0),result=useRetainedRead(api,{kind:'persona-development'},nonce);
  return <>{result.error&&<Band>{ui.errorText?.(result.error)??result.error} · 已显示的内容保留，修改前请重新读取。<Button disabled={busy||result.loading} onClick={()=>setNonce(n=>n+1)}>重新读取人格偏移</Button></Band>}{result.data?<PersonaContents key={s.sessionId} {...{api,s,busy:busy||!!result.error||result.loading,ui}} data={result.data} onChanged={()=>setNonce(n=>n+1)}/>:!result.error&&<Empty>正在读取人格偏移…</Empty>}</>;
}

const memoryFields=['enabled','intervalMs','newRecordThreshold','hotDays','coldDays'];
const memoryDraft=(settings:any)=>Object.fromEntries(memoryFields.map(key=>[key,settings[key]]));
function LifecycleContents({api,s,busy,ui,data,onChanged}:any){
  const {Button,Check,Field,Input,Band,Empty,Detail,JsonDetails}=ui;
  const [baseline,setBaseline]=useState(data.settings),[draft,setDraft]=useState(()=>memoryDraft(data.settings)),[restore,setRestore]=useState<any>(null);
  const dirty=JSON.stringify(draft)!==JSON.stringify(memoryDraft(baseline)),stale=data.settings.version!==baseline.version,locked=busy||s.agentBusy||s.desired!=='paused';
  useDraftGuard(dirty);
  useEffect(()=>{if(!dirty&&data.settings.version!==baseline.version){setBaseline(data.settings);setDraft(memoryDraft(data.settings));}},[data.settings,baseline.version,dirty]);
  const patch=(key:string,value:any)=>setDraft(previous=>({...previous,[key]:value}));
  const valid=Number.isSafeInteger(draft.intervalMs)&&draft.intervalMs>=3600000&&draft.intervalMs<=2592000000&&Number.isSafeInteger(draft.newRecordThreshold)&&draft.newRecordThreshold>=5&&draft.newRecordThreshold<=1000&&Number.isSafeInteger(draft.hotDays)&&draft.hotDays>=1&&draft.hotDays<=365&&Number.isSafeInteger(draft.coldDays)&&draft.coldDays>draft.hotDays&&draft.coldDays<=3650;
  const save=()=>api.run(async()=>{await api.control({op:'memory-lifecycle-configure',settings:draft,expectedVersion:baseline.version});const fresh=await api.read({kind:'memory-lifecycle'});setBaseline(fresh.settings);setDraft(memoryDraft(fresh.settings));onChanged();},'记忆整理设置已保存');
  const counts=data.counts??{},batches=data.batches??[];
  return <>
    <div className="hn-row hn-between"><h3>记忆整理</h3><Button disabled={busy} onClick={onChanged}>刷新整理状态</Button></div>
    <p className="hn-help">将相似记忆整理为可追溯摘要，把较旧、低优先级的记录下沉到温层或冷层。原记录仍保留，可查看来源并恢复整理批次。</p>
    <div className="hn-stats"><div><small>热记忆 · 近期常用</small><strong>{counts.hot??0}</strong></div><div><small>温记忆 · 按需召回</small><strong>{counts.warm??0}</strong></div><div><small>冷记忆 · 低频归档</small><strong>{counts.cold??0}</strong></div></div>
    <p className="hn-note">已固定 {counts.pinned??0} 条 · 恢复后保留原文 {counts.restoredHeld??0} 条 · 摘要 {counts.summaries??0} 条 · 重复记录 {counts.duplicates??0} 条{counts.invalidSummaries?` · ${counts.invalidSummaries} 条摘要依据已失效`:''}</p>
    <Check label="定期整理记忆" disabled={busy} value={draft.enabled} onChange={(value:boolean)=>patch('enabled',value)}/>
    <p className="hn-help">{draft.enabled?'满足时间或新增条数条件后，由自主调度安排整理。规则去重优先，必要时才使用模型生成摘要。':'暂停新的自动整理，已有摘要和冷热分层仍保留。'}聊天可抢占整理，不单独启动第二条思考线。</p>
    <details className="hn-advanced"><summary>高级：整理频率与冷热分层</summary><div className="hn-fields">
      <Field label="整理检查周期 · 小时" hint="1–720 小时。满足周期或新增条数条件后安排整理，实际执行仍受任务优先级与额度约束。"><Input type="number" min={1} max={720} step={1} disabled={busy||!draft.enabled} value={draft.intervalMs/3600000} onChange={(value:number)=>patch('intervalMs',Math.round(value*3600000))}/></Field>
      <Field label="新增记忆触发条数" hint="5–1,000 条。避免每新增一条就调用模型。"><Input type="number" min={5} max={1000} step={1} disabled={busy||!draft.enabled} value={draft.newRecordThreshold} onChange={(value:number)=>patch('newRecordThreshold',value)}/></Field>
      <Field label="近期热记忆范围 · 天" hint="1–365 天。近期、重要或固定的记忆优先保留。"><Input type="number" min={1} max={365} step={1} disabled={busy||!draft.enabled} value={draft.hotDays} onChange={(value:number)=>patch('hotDays',value)}/></Field>
      <Field label="低频冷记忆起点 · 天" hint="必须大于热记忆范围，最多 3,650 天；时间与重要度、使用情况共同参与分层。"><Input type="number" min={(draft.hotDays??0)+1} max={3650} step={1} disabled={busy||!draft.enabled} value={draft.coldDays} onChange={(value:number)=>patch('coldDays',value)}/></Field>
    </div></details>
    <SettingsNotice {...{s,ui}}/>
    {stale&&<Band>整理设置已在其他页面更新。当前草稿保留，请核对最新设置后保存。</Band>}
    {!valid&&<Band>请检查整理周期、条数和冷热天数；冷记忆天数必须大于热记忆天数。</Band>}
    <div className="hn-row"><Button primary disabled={locked||stale||!dirty||!valid} onClick={save}>保存记忆整理设置</Button>{dirty&&<Button onClick={()=>{setBaseline(data.settings);setDraft(memoryDraft(data.settings));}}>放弃此处修改并读取最新设置</Button>}</div>
    <ReviewStatus {...{api,s,busy,ui,dirty,onChanged}} runtime={data.runtime}/>
    <section className="hn-group"><h4 className="hn-section-heading">最近整理</h4><p>{data.lastRun?'最近检查于 '+clock(data.lastRun.at):'尚无整理记录'}</p>{data.lastRun?.kind&&<p className="hn-note">处理类型：{data.lastRun.kind}</p>}<p className="hn-note">摘要依据被修订或遗忘后，旧摘要会失效。归档减少默认上下文占用，相关冷记忆仍可按需召回。</p></section>
    <details className="hn-advanced"><summary>整理批次与来源 · {batches.length} 批</summary>
      {batches.length?batches.map((batch:any)=><details className="hn-group" key={batch.id}><summary>{clock(batch.created)} · {label(batch.status)} · {(batch.memoryIds??[]).length} 条原记忆</summary>{batch.summary&&<><h4>{batch.summary.title||'整理摘要'}</h4><p className="hn-preview">{batch.summary.text}</p><p className="hn-note">模型归纳，用于线索与召回；原始证据仍需核对。{batch.summary.valid===false?'此摘要的依据已变化，当前不参与召回。':''}</p><JsonDetails label="查看摘要引用与原文摘录" value={{refs:batch.summary.refs,quotes:batch.summary.quotes}}/></>}<p className="hn-note">完成时间：{clock(batch.completed)}{batch.restoredAt?' · 恢复于 '+clock(batch.restoredAt):''}</p><JsonDetails label="查看摘要与原记录编号" value={{batchId:batch.id,summaryId:batch.summaryId,memoryRefs:batch.memoryRefs??batch.memoryIds??[]}}/>{batch.status==='completed'&&!batch.restoredAt&&<div className="hn-row"><Button disabled={locked} onClick={()=>setRestore(batch)}>恢复此批原记忆</Button></div>}</details>):<Empty>整理完成后，摘要及对应原记录会出现在这里。</Empty>}
    </details>
    {restore&&<Detail title="恢复记忆整理批次" onClose={()=>setRestore(null)}><p>恢复 {clock(restore.created)} 整理批次的原记忆？该批摘要会退出活动召回，原记录按恢复规则重新参与检索，原始记录和审计仍保留。</p><div className="hn-row"><Button primary disabled={locked} onClick={()=>api.run(async()=>{await api.control({op:'memory-lifecycle-restore',batchId:restore.id,expectedVersion:restore.version});setRestore(null);onChanged();},'已恢复这批原记忆')}>确认恢复</Button><Button onClick={()=>setRestore(null)}>取消</Button></div></Detail>}
  </>;
}

export function MemoryLifecycle({api,s,busy,ui}:any){
  const {Button,Band,Empty}=ui,[nonce,setNonce]=useState(0),result=useRetainedRead(api,{kind:'memory-lifecycle'},nonce);
  return <>{result.error&&<Band>{ui.errorText?.(result.error)??result.error} · 已显示的内容保留，修改前请重新读取。<Button disabled={busy||result.loading} onClick={()=>setNonce(n=>n+1)}>重新读取记忆整理</Button></Band>}{result.data?<LifecycleContents key={s.sessionId} {...{api,s,busy:busy||!!result.error||result.loading,ui}} data={result.data} onChanged={()=>setNonce(n=>n+1)}/>:!result.error&&<Empty>正在读取记忆整理…</Empty>}</>;
}
