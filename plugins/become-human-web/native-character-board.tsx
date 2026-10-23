import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useDraftGuard,useDraftNavigation} from './native-shell';

const statuses:Record<string,string>={inbox:'待梳理',watching:'关注中',paused:'暂放',blocked:'受阻',completed:'已完成',dropped:'已放下'};
const kinds:Record<string,string>={research:'研究',conversation:'交流',question:'问题',goal:'目标',commitment:'承诺',other:'其他'};
const sourceLabels:Record<string,string>={owner:'主人创建',agent:'Agent 提出',goal:'关联目标',task:'关联任务',reflection:'结果反思',migration:'既有记录'};
const outcomeLabels:Record<string,string>={completed:'已完成',success:'已取得结果',failed:'未完成',blocked:'受阻',unknown:'结果待核对',cancelled:'已取消',suspended:'已暂停',waiting:'等待中'};
const capabilityStates:Record<string,string>={available:'可用',enabled:'已启用',ready:'可用',connected:'已连接',unavailable:'当前不可用',disabled:'未启用',unknown:'待核对',blocked:'受阻','approval-required':'需逐次批准','not-configured':'尚未配置'};
const columns=[{id:'inbox',label:'待梳理',states:['inbox']},{id:'watching',label:'关注中',states:['watching']},{id:'paused',label:'暂放与受阻',states:['paused','blocked']},{id:'closed',label:'已结束',states:['completed','dropped']}];
const time=(value:any)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未设置';
const textOf=(value:any):string=>typeof value==='string'?value:value?.text??value?.summary??value?.label??value?.title??value?.reason??value?.code??'';
const itemsOf=(value:any):any[]=>Array.isArray(value)?value:[];
const dateInput=(value:any)=>{if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.valueOf()))return '';return new Date(date.valueOf()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const closed=(item:any)=>['completed','dropped'].includes(item.status);
const tone=(status:string)=>['completed','success','available','enabled','connected','ready'].includes(status)?'success':['blocked','failed','unavailable','approval-required'].includes(status)?'warning':['paused','dropped','disabled','unknown'].includes(status)?'muted':undefined;
function useRequestIds(){const ids=useRef(new Map<string,string>());return (payload:any)=>{const key=JSON.stringify(payload);let id=ids.current.get(key);if(!id){id=crypto.randomUUID();ids.current.set(key,id);}return id;};}

function useBoard(api:any,sessionId:string){
  const [nonce,setNonce]=useState(0),[page,setPage]=useState({sessionId,limit:50}),[result,setResult]=useState<any>({data:null,error:'',loading:true,refreshing:false,sessionId}),limit=page.sessionId===sessionId?page.limit:50;
  useEffect(()=>{
    let live=true,inflight=false;
    const load=async()=>{
      if(inflight)return;inflight=true;
      setResult((previous:any)=>({...previous,...(previous.sessionId!==sessionId?{data:null,loading:true}:{}),sessionId,refreshing:true,error:''}));
      try{const data=await api.read({kind:'character-board',limit});if(live)setResult({data,error:'',loading:false,refreshing:false,sessionId});}
      catch(error:any){if(live)setResult((previous:any)=>({...previous,loading:false,refreshing:false,error:error.message??'人物看板读取失败'}));}
      finally{inflight=false;}
    };
    void load();const timer=setInterval(()=>void load(),15000);
    return ()=>{live=false;clearInterval(timer);};
  },[api,sessionId,nonce,limit]);
  return {...(result.sessionId===sessionId?result:{data:null,error:'',loading:true,refreshing:true,sessionId}),limit,refresh:()=>setNonce(value=>value+1),loadMore:()=>setPage(previous=>({sessionId,limit:Math.min(1000,(previous.sessionId===sessionId?previous.limit:50)+50)}))};
}

function Evidence({rows,label='依据与关联编号'}:any){
  const values=Array.isArray(rows)?rows:rows&&typeof rows==='object'?Object.entries(rows).filter(([,value])=>value!==null&&value!==undefined).map(([key,value]:any)=>({text:(({task:'任务',reason:'结果原因',attempts:'执行尝试',notes:'笔记',published:'已发布结果'} as any)[key]??key)+': '+(typeof value==='string'?value:typeof value==='boolean'?(value?'是':'否'):Array.isArray(value)?value.length+' 条':value?.id??value?.status??'已有记录')})):[];if(!values.length)return <p className="hn-board-caption">暂无关联依据。</p>;
  return <details><summary>{label} · {values.length}</summary><ul className="hn-board-evidence">{values.map((value:any,index:number)=><li key={value?.id??index}>{textOf(value)||value?.ref||value?.id||value?.sourceId||'记录 '+(index+1)}{typeof value==='object'&&value!==null&&value.id&&textOf(value)?<span className="hn-mono"> · {value.id}</span>:null}{value?.valid===false||['invalid','revoked','expired','deleted'].includes(value?.status)?<span> · 依据已失效</span>:null}</li>)}</ul></details>;
}

function ItemEditor({item,latest,api,ui,disabled,onClose,onReload,onChanged}:any){
  const {Detail,Field,Input,Text,Select,Button,Band}=ui;
  const [draft,setDraft]=useState(()=>({title:item?.title??'',kind:item?.kind??'question',priority:item?.priority??50,description:item?.description??'',why:item?.why??'',expectedOutcome:item?.expectedOutcome??'',nextAction:item?.nextAction??'',stopCondition:item?.stopCondition??'',reviewAt:dateInput(item?.reviewAt)}));
  const initial=useMemo(()=>JSON.stringify(draft),[]),dirty=JSON.stringify(draft)!==initial,stale=!!item&&!!latest&&latest.version!==item.version;
  const requestIdFor=useRequestIds();
  useDraftGuard(dirty);const patch=(key:string,value:any)=>setDraft(previous=>({...previous,[key]:value}));
  const invalidDate=!!draft.reviewAt&&!Number.isFinite(new Date(draft.reviewAt).valueOf());
  const save=()=>api.run(async()=>{const payload={op:item?'board-item-update':'board-item-create',...(item?{id:item.id,expectedVersion:item.version}:{}),...draft,reviewAt:draft.reviewAt?new Date(draft.reviewAt).valueOf():null};await api.control({...payload,requestId:requestIdFor(payload)});onChanged();onClose(true);},item?'事项已保存':'事项已添加到待梳理');
  return <Detail title={item?'编辑事项':'新建事项'} onClose={()=>onClose(false)}><div className="hn-board-editor">
    <p className="hn-board-form-note">事项供你和 Agent 共同查看。记录下一步不会自动恢复已暂停的驱动，也不会扩大工具或写入权限。</p>
    {stale?<Band>这项事项已被其他操作更新，当前草稿保留。请核对最新版本后重新编辑。<div className="hn-row"><Button disabled={disabled} onClick={()=>onReload(latest)}>放弃草稿，载入最新版本</Button></div></Band>:null}
    <div className="hn-fields">
      <Field wide label="事项名称"><Input value={draft.title} maxLength={160} onChange={(value:string)=>patch('title',value)}/></Field>
      <Field label="事项类别"><Select value={draft.kind} options={Object.entries(kinds)} onChange={(value:string)=>patch('kind',value)}/></Field>
      <Field label="重要程度 · 0–100" hint="用于安排关注顺序，不等同于立即执行。"><Input type="number" min={0} max={100} value={draft.priority} onChange={(value:number)=>patch('priority',value)}/></Field>
      <Field wide label="事项说明"><Text value={draft.description} maxLength={1200} onChange={(value:string)=>patch('description',value)}/></Field>
      <Field wide label="为什么关注"><Text value={draft.why} maxLength={500} rows={2} onChange={(value:string)=>patch('why',value)}/></Field>
      <Field wide label="预期结果"><Text value={draft.expectedOutcome} maxLength={500} rows={2} onChange={(value:string)=>patch('expectedOutcome',value)}/></Field>
      <Field wide label="下一步"><Text value={draft.nextAction} maxLength={500} rows={2} onChange={(value:string)=>patch('nextAction',value)}/></Field>
      <Field wide label="停止条件" hint="例如得到可核验答案后停止，或连续两次没有新证据时先放下。"><Text value={draft.stopCondition} maxLength={500} rows={2} onChange={(value:string)=>patch('stopCondition',value)}/></Field>
      <Field wide label="下次检查时间 · 可选" hint="这是注意力复查时间；需要定时通知请到“任务 → 定时任务”创建。"><Input type="datetime-local" value={draft.reviewAt} onChange={(value:string)=>patch('reviewAt',value)}/></Field>
    </div>
    <div className="hn-row hn-dialog-actions"><Button onClick={()=>onClose(false)}>取消</Button><Button primary disabled={disabled||stale||!draft.title.trim()||invalidDate||!Number.isSafeInteger(draft.priority)||draft.priority<0||draft.priority>100} onClick={save}>保存事项</Button></div>
  </div></Detail>;
}

function ItemDetail({item,data,api,ui,disabled,onClose,onEdit,onChanged,onTask,onSection}:any){
  const {Detail,Button,Band}=ui,[reason,setReason]=useState(''),requestIdFor=useRequestIds();
  const focusId=data.attention?.focusId,transition=(action:string)=>api.run(async()=>{const payload={op:'board-item-transition',id:item.id,expectedVersion:item.version,action,reason};await api.control({...payload,requestId:requestIdFor(payload)});onChanged();},'事项状态已更新');
  const focus=()=>api.run(async()=>{const payload={op:'board-focus-set',id:item.id,expectedVersion:data.attention?.version};await api.control({...payload,requestId:requestIdFor(payload)});onChanged();},'已设为当前关注');
  const relatedReflections=itemsOf(data.reflections).filter((record:any)=>record.itemId===item.id),relatedDecisions=itemsOf(data.decisions).filter((record:any)=>record.itemId===item.id);
  return <Detail title="事项详情" onClose={onClose}><div className="hn-row hn-between"><h3>{item.title}</h3><span className="hn-board-status" data-tone={tone(item.status)}>{statuses[item.status]??item.status}</span></div>
    <p className="hn-board-caption">{kinds[item.kind]??item.kind} · 重要程度 {item.priority} · {sourceLabels[item.source]??item.source??'来源未标注'} · 版本 {item.version}</p>
    <dl className="hn-board-facts">{[['事项说明',item.description],['为什么关注',item.why],['预期结果',item.expectedOutcome],['下一步',item.nextAction],['停止条件',item.stopCondition],['下次检查',time(item.reviewAt)]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'尚未填写'}</dd></div>)}</dl>
    <Evidence rows={item.refs}/><p className="hn-board-caption">创建 {time(item.created)} · 更新 {time(item.updated)}</p>
    <p className="hn-mono">事项编号 {item.id}</p>
    <div className="hn-row">{item.taskId?<Button onClick={()=>onTask(item.taskId)}>查看关联任务</Button>:null}{item.goalId?<Button onClick={()=>onSection('goals')}>前往关联目标</Button>:null}<Button disabled={disabled} onClick={onEdit}>编辑事项</Button>{!closed(item)&&focusId!==item.id?<Button primary disabled={disabled} onClick={focus}>设为当前关注</Button>:null}</div>
    {item.goalId?<p className="hn-mono">目标编号 {item.goalId}</p>:null}
    <Band>事项状态用于管理注意力；标记“已完成”不替代关联任务的回执或目标验收。已失败任务仍需按原规则明确重试。</Band>
    <ui.Field label="状态调整说明 · 可选"><ui.Text value={reason} maxLength={500} rows={2} onChange={setReason}/></ui.Field>
    <div className="hn-board-detail-actions">
      {!closed(item)&&item.status!=='watching'?<Button disabled={disabled} onClick={()=>transition('watch')}>加入关注</Button>:null}
      {!closed(item)&&item.status!=='paused'?<Button disabled={disabled} onClick={()=>transition('pause')}>暂放</Button>:null}
      {!closed(item)&&item.status!=='blocked'?<Button disabled={disabled} onClick={()=>transition('block')}>标记受阻</Button>:null}
      {!closed(item)?<><Button disabled={disabled} onClick={()=>transition('complete')}>标记已完成</Button><Button disabled={disabled} onClick={()=>transition('drop')}>放下事项</Button></>:<Button disabled={disabled} onClick={()=>transition('reopen')}>重新打开</Button>}
    </div>
    {(relatedDecisions.length||relatedReflections.length)?<section className="hn-group"><h4>关联经过</h4>{relatedDecisions.slice(0,5).map((record:any)=><article key={record.id} className="hn-board-record"><time>{time(record.at??record.created)}</time><p>{record.summary}</p><Evidence rows={record.basis}/></article>)}{relatedReflections.slice(0,5).map((record:any)=><article key={record.id} className="hn-board-record"><time>{time(record.at??record.created)}</time><p>结果：{textOf(record.result)||outcomeLabels[record.outcome]||record.outcome||'尚无结果摘要'}</p><p>下一步：{textOf(record.nextStep)||'尚无后续建议'}</p><Evidence rows={record.evidence}/></article>)}</section>:null}
  </Detail>;
}

function SelfModel({data,s,ui,onTask,onItem}:any){
  const {Empty}=ui,self=data.self??{},identity=self.identity??{},status=self.status??{},uncertainties=itemsOf(self.uncertainties),commitments=itemsOf(self.commitments),capabilities=itemsOf(self.capabilities);
  const identityRows=[['当前人物',identity.name??s.management.profile.name],['人物职责',identity.role??identity.responsibilities],['关系设定',identity.relationship],['配置兴趣',identity.configuredInterests??identity.interests],['配置目标',identity.configuredGoals]];
  const phase=({foreground:'正在与你交流',selection:'选择下一件事',executor:'正在处理任务',autonomous:'正在处理任务',reminder:'准备提醒',scheduled:'执行定时任务',idle:'待机',paused:'已暂停'} as any)[status.phase??status.activeLane];
  return <div className="hn-board-split"><div><section className="hn-board-panel"><h3>自我状态</h3><p className="hn-board-caption">从当前配置、运行状态与有效记录重新读取；缺少证据的内容保持未知。</p><dl className="hn-board-facts">{identityRows.filter(([,value])=>value&&(!Array.isArray(value)||value.length)).map(([label,value])=><div key={label as string}><dt>{label}</dt><dd>{Array.isArray(value)?value.map(textOf).join('、'):textOf(value)}</dd></div>)}<div><dt>运行现状</dt><dd>{typeof status==='string'?status:status.label??status.summary??phase??(status.paused?'自主已暂停':s.activeLane?'当前有任务正在处理':s.desired==='running'?'在线待机':'已暂停')}</dd></div>{status.waitReason?<div><dt>等待原因</dt><dd>{ui.errorText(textOf(status.waitReason))}</dd></div>:null}{status.error?<div><dt>需处理问题</dt><dd>{ui.errorText(textOf(status.error))}</dd></div>:null}<div><dt>思考线</dt><dd>唯一主会话；临时子任务结果统一写回</dd></div><div><dt>会话编号</dt><dd className="hn-mono">{s.sessionId}</dd></div></dl></section>
    <section className="hn-board-panel"><h3>能力配置</h3><p className="hn-board-caption">这里只反映配置是否启用和允许范围；实际连接及执行结果以任务回执为准，写操作继续逐次批准。</p>{capabilities.length?capabilities.map((capability:any)=>{const state=capability.state??capability.status??(typeof capability.available==='boolean'?(capability.available?'available':'unavailable'):'unknown');return <article className="hn-line" key={capability.id??capability.name}><div className="hn-grow"><strong>{capability.title??capability.name??capability.label??capability.id}</strong><p>{capability.unavailableReason?ui.errorText(capability.unavailableReason):capability.reason??capability.summary??capability.description??'暂无状态说明'}</p>{capability.autonomous!==undefined?<p>自主调用：{capability.autonomous?'按当前权限与预算':'需明确任务或批准'}</p>:null}</div><span className="hn-board-status" data-tone={tone(state)}>{state==='available'?'配置已启用':state==='unavailable'?'当前不可用':capabilityStates[state]??state}</span></article>;}):<Empty>当前没有能力配置快照。</Empty>}</section></div>
    <div><section className="hn-board-panel"><h3>已记录的承诺</h3><p className="hn-board-caption">只展示有记录的承诺与待完成事项，不从聊天措辞补造承诺。</p>{commitments.length?commitments.map((item:any)=><article className="hn-line" key={item.id??item.title}><div className="hn-grow"><strong>{item.title??item.summary}</strong><p>{statuses[item.status]??outcomeLabels[item.status]??item.status??'待核对'}{item.dueAt?' · '+time(item.dueAt):''}</p><Evidence rows={item.refs}/></div>{item.taskId?<ui.Button onClick={()=>onTask(item.taskId)}>查看任务</ui.Button>:null}{data.items?.some((row:any)=>row.id===item.id)?<ui.Button onClick={()=>onItem(item.id)}>查看事项</ui.Button>:null}</article>):<Empty>尚无已记录的承诺。</Empty>}</section>
    <section className="hn-board-panel"><h3>不知道与待确认</h3><p className="hn-board-caption">这些内容尚未得到足够确认，不作为已经成立的主人事实。</p>{uncertainties.length?uncertainties.map((item:any,index:number)=><article className="hn-line" key={item.id??index}><div><p>{textOf(item)}</p>{item.refs?<Evidence rows={item.refs}/>:null}</div></article>):<Empty>当前没有单独记录的待确认事项。</Empty>}</section></div></div>;
}

function AttentionCandidates({attention,items,ui,onItem}:any){
  const eligible=itemsOf(attention.eligible),held=itemsOf(attention.held),fallback=itemsOf(attention.candidates),rows=[...eligible.map((row:any)=>({row,held:false})),...held.map((row:any)=>({row,held:true})),...(!eligible.length&&!held.length?fallback.map((row:any)=>({row,held:false})):[])];
  const gateReasons=itemsOf(attention.gates?.reasons),gate=gateReasons.length?gateReasons.map(ui.errorText).join('、'):textOf(attention.gates??attention.gate),{Button}=ui;if(!rows.length&&!gate)return null;
  return <details className="hn-board-panel"><summary>注意力候选与等待原因{rows.length?' · '+rows.length+' 项':''}</summary>{gate?<p className="hn-board-caption">当前等待：{gate}</p>:null}{rows.map(({row,held:waiting}:any,index:number)=>{const id=typeof row==='string'?row:row.matterId??row.itemId??row.id??row.item?.id,item=items.find((value:any)=>value.id===id),reason=itemsOf(row.reasons).length?row.reasons.map(ui.errorText).join('、'):textOf(row.holdReason??row.reason??row.gate);return <article className="hn-line" key={(id??'candidate')+':'+index}><div className="hn-grow"><strong>{item?.title??row.title??row.item?.title??id??'候选事项'}</strong><p>{waiting?'当前等待':'可参与下一次选择'}{reason?' · '+reason:''}</p></div>{item?<Button onClick={()=>onItem(id)}>查看事项</Button>:null}</article>;})}</details>;
}

function ReflectionLog({data,api,ui,disabled,onChanged,onItem,onTask}:any){
  const {Button,Empty}=ui,reflections=itemsOf(data.reflections),decisions=itemsOf(data.decisions),requestIdFor=useRequestIds();
  const apply=(record:any,action:string)=>api.run(async()=>{const payload={op:action==='apply'?'board-reflection-apply':'board-reflection-dismiss',id:record.id,expectedVersion:record.version};await api.control({...payload,requestId:requestIdFor(payload)});onChanged();},action==='apply'?'反思建议已采纳':'已记录不采用这条建议');
  return <div className="hn-board-split"><section className="hn-board-panel"><h3>方向与决策摘要</h3><p className="hn-board-caption">保留选择了什么、依据是什么及关联任务；这里展示记录摘要。</p>{decisions.length?decisions.map((record:any)=><article className="hn-board-record" key={record.id}><time>{time(record.at??record.created)}</time><p>{record.summary??'暂无决策摘要'}</p>{record.outcome?<p className="hn-board-caption">结果：{textOf(record.outcome)||outcomeLabels[record.outcome]||record.outcome}</p>:null}<Evidence rows={record.basis}/><div className="hn-row">{record.itemId?<Button onClick={()=>onItem(record.itemId)}>查看事项</Button>:null}{record.taskId?<Button onClick={()=>onTask(record.taskId)}>查看任务</Button>:null}</div></article>):<Empty>尚无方向选择记录。后续事件循环会在有决策时留下摘要。</Empty>}</section>
    <section className="hn-board-panel"><h3>结果反思</h3><p className="hn-board-caption">比较预期与实际结果，保存可核对的依据，并提出后续建议。</p>{reflections.length?reflections.map((record:any)=>{
      const suggestion=record.suggestion,reviewStatus=suggestion?.status??record.review?.status??record.status,nextStep=record.nextStep??suggestion?.nextAction;
      const canApply=!!suggestion&&['pending','proposed',undefined].includes(reviewStatus)&&!['applied','dismissed'].includes(record.review?.status);
      return <article className="hn-board-record" key={record.id}><div className="hn-row hn-between"><time>{time(record.at??record.created)}</time>{record.outcome?<span className="hn-board-status" data-tone={tone(record.outcome)}>{outcomeLabels[record.outcome]??record.outcome}</span>:null}</div>
        {record.expectedOutcome?<p>原本预期：{record.expectedOutcome}</p>:null}<p>实际结果：{textOf(record.result)||textOf(record.comparison)||record.summary||'尚无结果摘要'}</p><Evidence rows={record.evidence}/>{nextStep?<p>下一步：{textOf(nextStep)}</p>:null}
        {record.evidenceValidityChanged?<p className="hn-board-caption">关联依据已变化，请先核对；旧建议不能直接采纳。</p>:null}{suggestion?<><p>建议：{textOf(suggestion)||record.recommendation?.reason||suggestion.nextAction||'暂无建议说明'}</p><p className="hn-board-caption">{({applied:'已采纳',dismissed:'已不采用',pending:'等待选择',proposed:'等待选择'} as any)[reviewStatus]??'等待选择'} · 采纳仅更新事项与关注，不扩大执行权限。</p></>:null}
        <div className="hn-row">{record.itemId?<Button onClick={()=>onItem(record.itemId)}>查看事项</Button>:null}{record.taskId?<Button onClick={()=>onTask(record.taskId)}>查看任务</Button>:null}{canApply?<><Button primary disabled={disabled||record.evidenceValidityChanged} onClick={()=>apply(record,'apply')}>采纳下一步</Button><Button disabled={disabled} onClick={()=>apply(record,'dismiss')}>不采用</Button></>:null}</div>
      </article>;
    }):<Empty>尚无结果反思。任务得到结果后会记录，不会为了填满看板额外调用模型。</Empty>}</section></div>;
}

export default function CharacterBoard({api,s,busy,ui,onSection,embedded=false,initialSection='items'}:any){
  const {Button,Field,Input,Select,Band,Empty,TaskDetail}=ui,result=useBoard(api,s.sessionId),data=result.data,[section,setSection]=useState(initialSection),[query,setQuery]=useState(''),[kind,setKind]=useState('all'),[status,setStatus]=useState('all'),[editing,setEditing]=useState<any>(undefined),[detailId,setDetailId]=useState(''),[taskId,setTaskId]=useState(''),navigation=useDraftNavigation(),requestIdFor=useRequestIds();
  const items=itemsOf(data?.items),attention=data?.attention??{},focus=items.find((item:any)=>item.id===attention.focusId),detail=items.find((item:any)=>item.id===detailId),latest=editing?items.find((item:any)=>item.id===editing.id):null;
  const visible=useMemo(()=>{const normalized=query.trim().toLocaleLowerCase();return items.filter((item:any)=>(kind==='all'||item.kind===kind)&&(status==='all'||item.status===status)&&(!normalized||[item.title,item.description,item.why,item.nextAction,item.id].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized))).sort((a:any,b:any)=>b.priority-a.priority||b.updated-a.updated);},[items,query,kind,status]);
  const stats=useMemo(()=>({open:items.filter((item:any)=>!closed(item)).length,watching:items.filter((item:any)=>item.status==='watching').length,blocked:items.filter((item:any)=>item.status==='blocked').length}),[items]);
  const clearFocus=()=>api.run(async()=>{const payload={op:'board-focus-clear',expectedVersion:attention.version};await api.control({...payload,requestId:requestIdFor(payload)});result.refresh();},'已清除当前关注');
  const closeEditor=(saved=false)=>{if(saved)setEditing(undefined);else navigation.navigate(()=>setEditing(undefined));};
  const openItem=(id:string)=>{if(items.some((item:any)=>item.id===id))setDetailId(id);else api.publish({error:'关联事项已不可用，请刷新人物看板后核对。'});};
  return <section className={'hn-character-board'+(embedded?' hn-board-embedded':'')} aria-label="关注与反思"><header className="hn-page-heading"><div>{!embedded?<><h2>关注与反思</h2><p>整理关注方向、已有能力和行动结果。</p></>:null}<p className="hn-board-caption">当前 Human 共享记录{data?' · 更新 '+time(data.updatedAt):''}</p></div><div className="hn-row"><Button disabled={result.refreshing} onClick={result.refresh}>{result.refreshing?'正在刷新…':'刷新记录'}</Button>{section==='items'?<Button primary disabled={busy||!data} onClick={()=>setEditing(null)}>新建事项</Button>:null}</div></header>
    {result.error?<div className="hn-notice hn-error" role="alert">{ui.errorText(result.error)}{data?' · 当前显示上一次成功读取的记录，刷新后再核对。':''}</div>:null}
    {result.loading&&!data?<Empty>正在读取人物看板…</Empty>:!data?<Band>暂时无法取得人物看板，请检查运行模块连接后刷新。</Band>:<>
      {!embedded?<nav className="hn-board-subnav" aria-label="关注与反思视图">{[['items','关注事项'],['self','自我状态'],['reflections','决策与反思']].map(([id,label])=><Button key={id} aria-pressed={section===id} onClick={()=>setSection(id)}>{label}</Button>)}</nav>:null}
      {section==='items'?<>
        <section className="hn-board-focus" aria-label="当前单一关注"><p className="hn-board-eyebrow">当前单一关注</p><h3>{focus?.title??(attention.focusedTaskId?'正在处理既有任务':'暂未设置关注事项')}</h3><p>{textOf(attention.reason)||(focus?'已指定关注方向，执行仍由事件循环和当前权限决定。':'可以从下方事项中选择，也可等待 Agent 根据当前人物、记忆与目标选择。')}</p>{attention.focusedTaskId?<p className="hn-board-caption">当前执行任务：{attention.focusedTaskId}。关注事项不代表另一条并行思考线。</p>:<p className="hn-board-caption">关注方向和实际执行状态分别记录；当前没有关联的执行任务。</p>}<Evidence rows={attention.basis} label="为什么关注这件事"/><p className="hn-board-caption">下次复查 {time(attention.nextReviewAt)}</p><div className="hn-row">{focus?<Button onClick={()=>openItem(focus.id)}>查看当前事项</Button>:null}{attention.focusedTaskId?<Button onClick={()=>setTaskId(attention.focusedTaskId)}>查看当前任务</Button>:null}{attention.focusId?<Button disabled={busy||!!result.error} onClick={clearFocus}>清除关注</Button>:null}</div></section>
        <AttentionCandidates {...{attention,items,ui}} onItem={openItem}/>
        <div className="hn-row hn-between"><p className="hn-board-count">已载入：待处理 {stats.open} · 关注中 {stats.watching} · 受阻 {stats.blocked}</p><p className="hn-board-count">筛选显示 {visible.length} · 已载入 {items.length} / {data.matters?.total??items.length} 项</p></div>
        <div className="hn-board-filters"><Field label="搜索事项"><Input type="search" value={query} placeholder="名称、说明或事项编号" onChange={setQuery}/></Field><Field label="事项类别"><Select value={kind} options={[["all","全部类别"],...Object.entries(kinds)]} onChange={setKind}/></Field><Field label="事项状态"><Select value={status} options={[["all","全部状态"],...Object.entries(statuses)]} onChange={setStatus}/></Field></div>
        <p className="hn-board-caption">搜索与筛选仅作用于已载入的事项；有更多记录时，可继续载入。</p>
        {!items.length?<Empty>还没有事项。可以记录一个问题、承诺或想继续探索的方向，Agent 后续也会将有依据的关注事项记在这里。</Empty>:!visible.length?<Empty>没有匹配事项，请调整搜索或筛选条件。</Empty>:<div className="hn-board-columns">{columns.map(column=>{const rows=visible.filter((item:any)=>column.states.includes(item.status));return <section className="hn-board-column" key={column.id} aria-label={column.label}><header><h3>{column.label}</h3><span className="hn-board-count">{rows.length}</span></header>{rows.length?rows.map((item:any)=><article className="hn-board-card" key={item.id} data-focused={attention.focusId===item.id}><div className="hn-board-tags"><span className="hn-board-tag">{kinds[item.kind]??item.kind}</span><span className="hn-board-tag">重要程度 {item.priority}</span>{attention.focusId===item.id?<span className="hn-board-status">当前关注</span>:null}</div><h4>{item.title}</h4><p>{item.nextAction||item.why||item.description||'尚未填写下一步'}</p><p className="hn-board-caption">{statuses[item.status]??item.status} · 更新 {time(item.updated)}</p>{item.reviewAt?<p className="hn-board-caption">检查 {time(item.reviewAt)}</p>:null}<div className="hn-row"><Button onClick={()=>openItem(item.id)}>查看事项</Button><Button disabled={busy} onClick={()=>setEditing(item)}>编辑</Button></div></article>):<Empty>暂无事项</Empty>}</section>;})}</div>}
        {data.matters?.hasMore?<div className="hn-row" style={{marginTop:20}}><p className="hn-board-caption">已载入 {items.length} / {data.matters.total} 项。</p>{result.limit<1000?<Button disabled={result.refreshing} onClick={result.loadMore}>{result.refreshing?'正在载入…':'继续载入 50 项'}</Button>:<p className="hn-board-caption">已达到本页 1,000 项显示上限。其余记录仍保留，当前搜索不包含未载入记录。</p>}</div>:null}
        <Band>添加、关注或重开事项只更新看板。需要执行研究、发送消息或写入文件时，继续遵守当前自主开关、额度和原有权限；失败任务不会因此自动重试。</Band>
      </>:section==='self'?<SelfModel {...{data,s,ui}} onTask={setTaskId} onItem={openItem}/>:<ReflectionLog {...{data,api,ui}} disabled={busy} onChanged={result.refresh} onItem={openItem} onTask={setTaskId}/>}
    </>}
    {editing!==undefined?<ItemEditor key={editing?editing.id+':'+editing.version:'new'} item={editing} latest={latest} {...{api,ui}} disabled={busy||!!result.error} onClose={closeEditor} onChanged={result.refresh} onReload={(item:any)=>navigation.navigate(()=>setEditing(item))}/>:null}
    {detail?<ItemDetail item={detail} {...{data,api,ui,onSection}} disabled={busy||!!result.error} onClose={()=>setDetailId('')} onEdit={()=>{setDetailId('');setEditing(detail);}} onChanged={result.refresh} onTask={setTaskId}/>:null}
    {taskId?<TaskDetail api={api} id={taskId} onClose={()=>setTaskId('')}/>:null}
  </section>;
}
