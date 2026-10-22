import React,{useEffect,useRef,useState} from 'react';
import personaCatalog from './runtime/presets/personas.json';
import budgetCatalog from './runtime/presets/autonomy-budgets.json';
import css from './native-onboarding.css';

type Route={provider:string;model:string;providerLabel?:string;modelLabel?:string;credentialReady:boolean};
type Choices={provider:string;model:string;personaPreset:string;budgetPreset:string;ownerName:string;timeZone:string;startAutonomy:boolean};
const personas=personaCatalog.presets,budgets=budgetCatalog.presets;
const steps=['选择模型','人物与额度','确认并启动'];
const routeKey=(value:{provider:string;model:string})=>JSON.stringify([value.provider,value.model]);
const browserTimeZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Shanghai';}catch{return 'Asia/Shanghai';}};
const validTimeZone=(value:string)=>{try{new Intl.DateTimeFormat('zh-CN',{timeZone:value}).format();return !!value.trim();}catch{return false;}};
const initialChoices=(setup:any):Choices=>{
 const selected=setup.pending??setup.defaultRoute??setup.models?.find((route:Route)=>route.credentialReady)??{};
 return {provider:selected.provider??'',model:selected.model??'',personaPreset:setup.pending?.personaPreset??'zhiqiu',budgetPreset:setup.pending?.budgetPreset??'low',ownerName:setup.pending?.ownerName??'',timeZone:setup.pending?.timeZone??browserTimeZone(),startAutonomy:setup.pending?.startAutonomy===true};
};
const number=(value:number)=>value.toLocaleString('zh-CN');

export default function Onboarding({api,s,busy,ui,error='',transportError=''}:any){
 const {Button,Field,Input,Select,Check,Band}=ui,setup=s.setup;
 const [choices,setChoices]=useState<Choices>(()=>initialChoices(setup));
 const [step,setStep]=useState(()=>setup.pending?2:0),[validation,setValidation]=useState(''),[reviewRevision,setReviewRevision]=useState(setup.revision);
 const request=useRef<{signature:string;requestId:string}|null>(null),heading=useRef<HTMLHeadingElement>(null);
 const pendingKey=setup.pending?.requestId??'',previousPendingKey=useRef(pendingKey),locked=!!setup.pending,creating=setup.phase==='creating';
 const disabled=busy||creating||!!transportError,models:Route[]=setup.models??[],route=models.find(item=>item.provider===choices.provider&&item.model===choices.model);
 const persona=personas.find(item=>item.id===choices.personaPreset)??personas[0],budget=budgets.find(item=>item.id===choices.budgetPreset)??budgets[0];
 const supported=setup.environment?.supported!==false,modelReady=!!route?.credentialReady,stale=!locked&&reviewRevision!==setup.revision;
 const serverError=error||setup.error,canSubmit=supported&&modelReady&&validTimeZone(choices.timeZone)&&!disabled&&!stale;
 useEffect(()=>{heading.current?.focus();},[step]);
 useEffect(()=>{
  const previous=previousPendingKey.current;previousPendingKey.current=pendingKey;
  if(!pendingKey){if(previous){request.current=null;setChoices(initialChoices(setup));setStep(0);setReviewRevision(setup.revision);setValidation('');}return;}
  setChoices(initialChoices(setup));setStep(2);setReviewRevision(setup.revision);setValidation('');
  request.current={signature:JSON.stringify(setup.pending),requestId:pendingKey};
 },[pendingKey]);
 useEffect(()=>{
  if(locked||choices.provider||choices.model)return;
  const candidate=setup.defaultRoute??models.find(item=>item.credentialReady);
  if(candidate)setChoices(current=>current.provider||current.model?current:{...current,provider:candidate.provider,model:candidate.model});
 },[setup.defaultRoute?.provider,setup.defaultRoute?.model,models.length,locked,choices.provider,choices.model]);
 function patch<K extends keyof Choices>(key:K,value:Choices[K]){setChoices(current=>({...current,[key]:value}));setValidation('');}
 function go(next:number){
  if(disabled||locked)return;
  if(next>0&&(!supported||!modelReady)){setValidation('请先选择凭据可用的模型，并完成环境检查。');return;}
  if(next>1&&!validTimeZone(choices.timeZone)){setValidation('请填写有效时区，例如 Asia/Shanghai 或 UTC。');return;}
  if(next===2)setReviewRevision(setup.revision);
  setValidation('');setStep(next);
 }
 function refresh(){void api.run(()=>api.control({op:'setup-refresh'}),'环境与模型列表已更新');}
 function reset(){
  if(disabled||setup.phase!=='failed'||!setup.canReset||!pendingKey)return;
  void api.run(()=>api.control({op:'setup-reset',expectedRevision:setup.revision,requestId:pendingKey}),'已返回首次设置，可以重新选择');
 }
 function submit(){
  if(!canSubmit)return;
  const payload={...choices,ownerName:choices.ownerName.trim(),timeZone:choices.timeZone.trim()},signature=JSON.stringify(payload);
  if(!request.current||request.current.signature!==signature)request.current={signature,requestId:setup.pending?.requestId??crypto.randomUUID()};
  const requestId=setup.pending?.requestId??request.current.requestId;
  void api.run(()=>api.control({op:'setup-complete',...payload,requestId,expectedRevision:setup.revision}),'首次设置已保存，请查看运行状态');
 }
 return <><style>{css}</style><div className="hn-onboarding">
  <header className="hn-onboarding-header"><span className="hn-onboarding-mark" aria-hidden="true">H</span><div><h1>欢迎使用 Become Human</h1><p>选好模型与相处方式，创建你的唯一 Human 会话。</p></div><span className="hn-onboarding-beta">测试版本</span></header>
  <div className="hn-onboarding-scroll"><div className="hn-onboarding-workspace">
   <nav aria-label="首次设置步骤" className="hn-onboarding-steps"><ol>{steps.map((label,index)=><li key={label}><button type="button" aria-current={index===step?'step':undefined} disabled={disabled||locked||index>step} onClick={()=>go(index)}><span aria-hidden="true">{index<step?'✓':index+1}</span>{label}</button></li>)}</ol></nav>
   <main className="hn-onboarding-card" aria-busy={busy||creating}>
    <div className="hn-onboarding-section-heading"><small>首次设置 · {step+1} / 3</small><h2 ref={heading} tabIndex={-1}>{steps[step]}</h2><p>{step===0?'复用 DSH 中已经配置的模型，无需在这里再次填写 API 密钥。':step===1?'从预设开始，创建后可以继续修改人物、额度和交流方式。':'核对这次选择，然后交给插件自动准备运行环境。'}</p></div>
    {(serverError||transportError||validation)&&<div className="hn-notice hn-error" role="alert">{validation||transportError||ui.errorText(serverError)}</div>}
    {creating&&<Band><div role="status" aria-live="polite">正在准备运行环境并保存首次设置，请稍候……</div></Band>}
    {locked&&setup.phase==='failed'&&<Band>已保留本次初始化进度。继续后会使用同一个会话完成剩余步骤。</Band>}
    {step===0&&<>
     <section aria-label="环境检查" className="hn-onboarding-environment"><div className="hn-row hn-between"><strong>{supported?'运行环境已识别':'运行环境需要处理'}</strong><Button disabled={disabled} onClick={refresh}>重新检查</Button></div><dl><div><dt>Node.js</dt><dd>{setup.environment?.node||'正在读取'}</dd></div><div><dt>DSH</dt><dd>{setup.environment?.dsh||'正在读取'}</dd></div><div><dt>当前配置</dt><dd>{setup.environment?.sourceProfile||'正在读取'}</dd></div></dl>{setup.environment?.issues?.length>0&&<ul className="hn-onboarding-issues">{setup.environment.issues.map((issue:any,index:number)=><li key={issue.code+':'+index}>{issue.message||ui.errorText(issue.code)}</li>)}</ul>}</section>
     <div className="hn-fields"><Field label="使用哪个模型" wide hint="列表显示当前支持导入的 DSH 模型。选择与初始化过程不会额外发起模型测试调用。"><Select aria-label="选择首次使用的模型" value={choices.provider&&choices.model?routeKey(choices):''} disabled={disabled||!models.length} onChange={(key:string)=>{const selected=models.find(item=>routeKey(item)===key);if(selected){setChoices(current=>({...current,provider:selected.provider,model:selected.model}));setValidation('');}}} options={[["","请选择模型"],...models.map(item=>[routeKey(item),(item.providerLabel||item.provider)+' / '+(item.modelLabel||item.model)+(item.credentialReady?'':' · 凭据待配置')])]}/></Field></div>
     {!models.length?<Band>还没有找到可用的兼容模型。请在 DSH 的模型设置中配置提供商和模型，保存后回到这里点击“重新检查”。</Band>:route&&!route.credentialReady?<Band>该模型尚未取得可用的凭据引用。请先在 DSH 中补全密钥配置，再重新检查。</Band>:null}
     <p className="hn-help">插件会自动选择数据目录与内部端口。手机渠道可以在创建后从“设置 → 手机连接”中绑定。</p>
    </>}
    {step===1&&<fieldset disabled={disabled} className="hn-onboarding-fieldset">
     <legend>选择人物</legend><div className="hn-onboarding-choices">{personas.map(item=><label key={item.id} className={'hn-onboarding-choice'+(choices.personaPreset===item.id?' hn-onboarding-choice-selected':'')}><input type="radio" name="human-onboarding-persona" value={item.id} checked={choices.personaPreset===item.id} onChange={()=>patch('personaPreset',item.id)}/><div><strong>{item.name}</strong><p>{item.description}</p></div></label>)}</div>
     <details className="hn-onboarding-preview"><summary>查看{persona.config.name}的人物设定</summary><dl>{[['name','名字'],['role','角色与关系'],['corePrompt','核心人格'],['interests','兴趣'],['goals','长期方向']].map(([key,label])=><div key={key}><dt>{label}</dt><dd>{(persona.config as any)[key]}</dd></div>)}</dl></details>
     <div className="hn-fields"><Field label="希望 Human 怎样称呼你 · 可选" hint="稍后可以在“人格与关系”中补充资料。"><Input value={choices.ownerName} onChange={(value:string)=>patch('ownerName',value)} maxLength={64} autoComplete="nickname" placeholder="例如：阿天"/></Field><Field label="你的时区" hint="默认使用浏览器时区，按创建时的 UTC 偏移保存。夏令时切换后需在设置中校正。"><Input value={choices.timeZone} onChange={(value:string)=>patch('timeZone',value)} maxLength={100} spellCheck={false} placeholder="Asia/Shanghai"/></Field></div>
     <h3>自主额度</h3><p className="hn-help">先从低额度开始。额度只限制自主活动，主人主动聊天单独计量。</p><div className="hn-onboarding-budgets">{budgets.map(item=><label key={item.id} className={'hn-onboarding-choice'+(choices.budgetPreset===item.id?' hn-onboarding-choice-selected':'')}><input type="radio" name="human-onboarding-budget" value={item.id} checked={choices.budgetPreset===item.id} onChange={()=>patch('budgetPreset',item.id)}/><div><strong>{item.name}{item.id==='low'&&<small>推荐起步</small>}</strong><p>{item.description}</p></div></label>)}</div>
     <p className="hn-help">预留 token 用于保守控制调用开销，不等同于供应商实际账单。创建后仍可自行配置上限。</p>
    </fieldset>}
    {step===2&&<>
     <dl className="hn-onboarding-summary"><div><dt>模型</dt><dd>{route?(route.providerLabel||route.provider)+' / '+(route.modelLabel||route.model):choices.provider+' / '+choices.model}</dd></div><div><dt>人物</dt><dd>{persona.name}</dd></div><div><dt>你的称呼</dt><dd>{choices.ownerName.trim()||'稍后填写'}</dd></div><div><dt>时区</dt><dd>{choices.timeZone}</dd></div><div><dt>自主额度</dt><dd>{budget.name} · 每个本地自然日 {number(budget.config.tokenLimit)} 预留 token / {budget.config.requestLimit} 次请求 / {budget.config.roundLimit} 轮</dd></div></dl>
     <Check label="同时开启自主学习和主动交流" value={choices.startAutonomy} onChange={(value:boolean)=>patch('startAutonomy',value)} disabled={disabled||locked}/><p className="hn-help">{choices.startAutonomy?'启动后按当前检查间隔判断是否有值得做的事，模型调用使用上面选择的自主额度。':'创建后先开启聊天，自主行为保持关闭；你可以稍后在“自主行为”中开启。'}</p>
     <Band>点击后会创建唯一会话，自动准备并启动后台。网页和之后绑定的手机共享该会话；关闭浏览器页面后，只要 DSH 服务仍在运行，Human 就可以继续工作。</Band>
     {stale&&<div className="hn-notice hn-error" role="alert">环境或模型列表已更新，请核对最新信息后再启动。<Button disabled={disabled} onClick={()=>{setReviewRevision(setup.revision);setValidation('');}}>使用最新检查结果</Button></div>}
     {!supported&&<Band>当前运行环境未通过检查，请返回第一步处理。</Band>}
     {!modelReady&&<Band>{locked?'所选模型当前不可用，请在 DSH 中补全该模型与凭据后重新检查。':'所选模型当前不可用，请返回第一步检查模型与凭据。'}</Band>}
     <div className="hn-row"><Button disabled={disabled} onClick={refresh}>重新检查环境与模型</Button>{setup.phase==='failed'&&setup.canReset&&<Button disabled={disabled} onClick={reset}>重新选择</Button>}<small>更新检查结果会保留本次人物与额度选择。</small></div>
    </>}
    <footer className="hn-onboarding-actions"><span>{step===2?'首次设置会保存在本机。':'稍后仍可在 Human 设置中调整。'}</span><div className="hn-row">{step>0&&!locked&&<Button disabled={disabled} onClick={()=>go(step-1)}>上一步</Button>}{step<2?<Button primary disabled={disabled||step===0&&(!supported||!modelReady)} onClick={()=>go(step+1)}>下一步</Button>:<Button primary disabled={!canSubmit} onClick={submit}>{creating||busy?'正在准备…':locked?'继续创建并启动':'创建并启动'}</Button>}</div></footer>
   </main><p className="hn-onboarding-footer">Become Human · 测试版本，功能仍在完善中。</p>
  </div></div>
 </div></>;
}
