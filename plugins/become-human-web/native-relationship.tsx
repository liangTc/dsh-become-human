import React,{useEffect,useState} from 'react';
import {useDraftGuard,pauseForConfiguration} from './native-shell';
import {useRetainedRead} from './native-disclosure';
import css from './native-relationship-media.css';

const metricDefinitions=[['affection','好感度','相处是否愉快、愿不愿意靠近。'],['intimacy','亲密度','熟悉程度与愿意分享、交流的距离。'],['trust','信任度','对承诺、尊重和相处稳定性的判断。']];
const stances:any={agree:'愿意',negotiate:'想商量一下',decline:'暂不愿意'};
const clock=(value:any)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚无记录';
const draftOf=(settings:any)=>({enabled:settings.enabled,initial:{...settings.initial},maxDeltaPerTurn:settings.maxDeltaPerTurn,positiveDailyLimit:settings.positiveDailyLimit,negativeDailyLimit:settings.negativeDailyLimit});
const isInt=(value:any,min:number,max:number)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

function RelationshipContents({api,s,busy,ui,data,onChanged,mode}:any){
 const {Button,Check,Field,Input,Band,Empty,JsonDetails}=ui,[baseline,setBaseline]=useState(data.settings),[draft,setDraft]=useState(()=>draftOf(data.settings));
 const dirty=JSON.stringify(draft)!==JSON.stringify(draftOf(baseline)),stale=data.settings.version!==baseline.version,locked=busy||s.agentBusy||s.desired!=='paused';
 useDraftGuard(dirty);
 useEffect(()=>{if(!dirty&&data.settings.version!==baseline.version){setBaseline(data.settings);setDraft(draftOf(data.settings));}},[data.settings,baseline.version,dirty]);
 const patch=(key:string,value:any)=>setDraft(previous=>({...previous,[key]:value})),patchInitial=(key:string,value:number)=>setDraft(previous=>({...previous,initial:{...previous.initial,[key]:value}}));
 const valid=typeof draft.enabled==='boolean'&&metricDefinitions.every(([key])=>isInt(draft.initial[key],0,100))&&isInt(draft.maxDeltaPerTurn,1,5)&&isInt(draft.positiveDailyLimit,1,20)&&isInt(draft.negativeDailyLimit,1,20);
 const save=()=>api.run(async()=>{await pauseForConfiguration(api);await api.control({op:'relationship-configure',settings:draft,expectedVersion:baseline.version,expectedRevision:s.management.revision});const fresh=await api.read({kind:'relationship'});setBaseline(fresh.settings);setDraft(draftOf(fresh.settings));onChanged();},'关系与自主选择设置已保存');
 const history=Array.isArray(data.history)?data.history:[];
 return <section className="hn-relationship" aria-label="关系状态与自主选择"><style>{css}</style>
  <div className="hn-row hn-between"><h3>关系与自主选择</h3><Button disabled={busy} onClick={onChanged}>{mode==='settings'?'重新读取设置':'刷新关系状态'}</Button></div>
  <p className="hn-help">人物可以愿意、拒绝，也可以提出条件或改变主意。解释、协商与真诚的示好会进入判断；关系数值只提供背景，不会让人物到分数就必定同意。</p>
  {mode!=='settings'&&<div className="hn-relationship-metrics">{metricDefinitions.map(([key,label,description])=><div className="hn-relationship-meter" key={key}><div><span>{label}</span><strong>{Math.round(data.metrics?.[key]??draft.initial[key])}<small> / 100</small></strong></div><meter min={0} max={100} value={data.metrics?.[key]??draft.initial[key]} aria-label={'当前'+label}/><small>{description}</small></div>)}</div>
  }{mode!=='records'&&<><Check label="启用关系变化与自主选择" disabled={busy} value={draft.enabled} onChange={(value:boolean)=>patch('enabled',value)}/>
  <p className="hn-help">{draft.enabled?'根据有效互动记录缓慢调整关系，并结合人格与情境作选择。重复催促或重复夸奖不会无限加分。':'暂停新的关系变化与意愿记录，已有互动记录保留。'}聊天默认不展示评分。关系变化不会替代工具授权、额度或行动审批。</p>
  <details className="hn-advanced"><summary>关系起点与变化幅度</summary><p className="hn-help">起点表示你希望从怎样的关系开始。修改起点不会清空历史，当前数值会结合仍有效的变化重新计算。</p><div className="hn-fields">
   {metricDefinitions.map(([key,label])=><Field key={key} label={label+'起点'} hint="0–100，只是关系背景，不是同意阈值。"><Input type="number" min={0} max={100} step={1} value={draft.initial[key]} disabled={busy} onChange={(value:number)=>patchInitial(key,value)}/></Field>)}
   <Field label="每项单次变化上限" hint="1–5。每个指标在一次互动中最多增加或减少的数值。"><Input type="number" min={1} max={5} step={1} value={draft.maxDeltaPerTurn} disabled={busy} onChange={(value:number)=>patch('maxDeltaPerTurn',value)}/></Field>
   <Field label="每项24小时正向上限" hint="1–20。每个指标在过去24小时内最多增加的数值，避免连续示好快速刷分。"><Input type="number" min={1} max={20} step={1} value={draft.positiveDailyLimit} disabled={busy} onChange={(value:number)=>patch('positiveDailyLimit',value)}/></Field>
   <Field label="每项24小时负向上限" hint="1–20。每个指标在过去24小时内最多减少的数值，避免一次不愉快让关系骤变。"><Input type="number" min={1} max={20} step={1} value={draft.negativeDailyLimit} disabled={busy} onChange={(value:number)=>patch('negativeDailyLimit',value)}/></Field>
  </div></details>
  {s.desired!=='paused'||s.agentBusy?<Band>保存此处修改会先暂停，草稿会保留。</Band>:<p className="hn-help">保存后仍保持暂停，准备好时可在右上角恢复运行。</p>}
  {stale&&<Band>关系设置已在其他页面更新。当前草稿保留，请先核对最新设置。</Band>}
  {!valid&&<Band>请检查关系起点及变化上限，数值需为标注范围内的整数。</Band>}
  <div className="hn-row"><Button primary disabled={busy||stale||!dirty||!valid} onClick={save}>保存关系与自主选择</Button>{dirty&&<Button onClick={()=>{setBaseline(data.settings);setDraft(draftOf(data.settings));}}>放弃此处修改</Button>}</div>
  </>}{mode!=='settings'&&<details className="hn-advanced"><summary>最近的选择与变化 · {history.length} 条</summary><p className="hn-help">这里只展示选择摘要及可核对的互动依据，供你理解人物如何相处。它不是逐字的内部思考过程。依据失效的记录不再参与关系计算。</p>
   {history.length?history.slice().sort((a:any,b:any)=>b.created-a.created).map((entry:any)=><details className={'hn-choice-history'+(entry.status==='invalid'?' hn-choice-invalid':'')} key={entry.assistantMessageId}><summary><span className="hn-tag">{stances[entry.stance]??'待核对'}</span><span>{entry.status==='invalid'?'依据已失效':entry.reconsiderOf?'重新考虑后的选择':'一次选择'}</span><time>{clock(entry.created)}</time></summary><p>{entry.status==='invalid'?'关联内容已撤回。':entry.reasonSummary||'尚无选择摘要。'}</p>{entry.developmentOnly&&<p className="hn-note">开发测试记录，不计入关系变化。</p>}{entry.reconsiderReason&&<p><strong>重新考虑的依据：</strong>{entry.reconsiderReason}</p>}<JsonDetails label="查看关系变化与依据编号" value={{appliedDelta:entry.appliedDelta,proposedDelta:entry.proposedDelta,evidenceSourceIds:entry.evidenceSourceIds,reconsiderOf:entry.reconsiderOf,status:entry.status}}/></details>):<Empty>有真实互动与选择后，记录会出现在这里。</Empty>}
  </details>
  }
 </section>;
}
export default function RelationshipSettings({api,s,busy,ui,mode='all'}:any){
 const [nonce,setNonce]=useState(0),readNonce=nonce+Number(s.management?.revision??0)+Number(s.messages?.at(-1)?.seq??0),result=useRetainedRead(api,{kind:'relationship'},readNonce),{Band,Button,Empty}=ui;
 return <>{result.error&&<Band>{ui.errorText?.(result.error)??result.error} · 已显示的关系内容保留，重新读取前不能保存。<Button disabled={busy||result.loading} onClick={()=>setNonce(value=>value+1)}>重新读取关系状态</Button></Band>}{result.data?<RelationshipContents key={s.sessionId} {...{api,s,ui}} busy={busy||!!result.error||result.loading} mode={mode} data={result.data} onChanged={()=>setNonce(value=>value+1)}/>:!result.error&&<Empty>正在读取关系状态…</Empty>}</>;
}
