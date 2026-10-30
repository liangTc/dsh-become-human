import React,{useRef,useState} from 'react';
import personaCatalog from './runtime/presets/personas.json';
import budgetCatalog from './runtime/presets/autonomy-budgets.json';
import {PRESET_MAX_BYTES,PERSONA_PRESET_KEYS,AUTONOMY_BUDGET_PRESET_KEYS,extractPersonaConfig,extractAutonomyBudgetConfig,listPresetCatalog,parsePresetFile,exportPresetFile} from './runtime/preset-config.mjs';

const catalogs:any={persona:listPresetCatalog(personaCatalog,'persona'),'autonomy-budget':listPresetCatalog(budgetCatalog,'autonomy-budget')};
const errors:Record<string,string>={PRESET_FILE_TOO_LARGE:'配置文件最多支持64 KiB。',PRESET_KIND_MISMATCH:'文件类型不匹配，请使用当前分类导出的配置文件。',INVALID_PRESET_KIND:'配置类型无效，请使用人物或自主额度配置。',INVALID_PRESET_CONFIGURATION:'请检查配置字段、数值范围和类型；配置中不能混入主人资料、运行频率或权限字段。',INVALID_PRESET_METADATA:'配置名称或说明格式无效。',INVALID_PRESET_FILE:'无法读取该JSON配置，请使用从本界面导出的格式。'};
const equal=(a:any,b:any)=>Object.keys(a).every(key=>a[key]===b[key])&&Object.keys(a).length===Object.keys(b).length;
const extract=(kind:string,value:any)=>kind==='persona'?extractPersonaConfig(value):extractAutonomyBudgetConfig(value);
const num=(value:number)=>value.toLocaleString('zh-CN');
const period:Record<string,string>={'local-day':'本地自然日','utc-day':'UTC 自然日','rolling-day':'滚动24小时'};

export function QuickPresetPicker({kind,value,onApply,dirty=false,ui,onCustom}:any){
 const {Button,Select,Detail}=ui,isPersona=kind==='persona',entries=catalogs[kind],keys=isPersona?PERSONA_PRESET_KEYS:AUTONOMY_BUDGET_PRESET_KEYS;
 const current=Object.fromEntries(keys.map((key:string)=>[key,value[key]])),matched=entries.find((entry:any)=>equal(entry.config,current));
 const [pending,setPending]=useState<any>(null),[custom,setCustom]=useState(false);
 const apply=(entry:any)=>{setCustom(false);onApply(entry.config);setPending(null);};
 const choose=(id:string)=>{if(!id){setCustom(true);onCustom?.();return;}const entry=entries.find((item:any)=>item.id===id);if(!entry)return;if(dirty)setPending(entry);else apply(entry);};
 return <section className="hn-quick-preset" aria-label={isPersona?'人物预设':'自主额度预设'}>
  {isPersona?<label className="hn-field"><span>人物预设</span><Select aria-label="人物预设" value={custom?'':matched?.id??''} options={[["","自行配置"],...entries.map((entry:any)=>[entry.id,entry.name])]} onChange={choose}/></label>:<><div className="hn-budget-options" role="radiogroup" aria-label="自主额度档位">{[...entries,{id:'',name:'自定义'}].map((entry:any)=><label key={entry.id}><input type="radio" name="human-budget-preset" checked={entry.id?(matched?.id===entry.id&&!custom):(!matched||custom)} onChange={()=>choose(entry.id)}/><span>{entry.name}</span></label>)}</div><p className="hn-help">{period[value.budgetWindow]??'当前周期'} · {value.tokenQuotaEnabled?num(value.tokenLimit)+' token':'token 不限'} / {value.requestQuotaEnabled?num(value.requestLimit)+' 次请求':'请求不限'} / {value.roundQuotaEnabled?num(value.roundLimit)+' 轮':'轮次不限'}</p></>}
  <details className="hn-preset-import"><summary>导入或导出配置</summary><PresetPicker {...{kind,value,onApply,dirty,ui}}/></details>
  {pending&&<Detail title="替换当前预设草稿？" onClose={()=>setPending(null)}><p>当前尚有修改。载入“{pending.name}”会替换对应的{isPersona?'人物':'额度'}字段，其他设置保留；保存后才生效。</p><div className="hn-row"><Button onClick={()=>setPending(null)}>继续编辑</Button><Button primary onClick={()=>apply(pending)}>替换草稿</Button></div></Detail>}
 </section>;
}

export default function PresetPicker({kind,value,onApply,dirty=false,ui}:any){
 const {Button,Select,Detail}=ui,entries=catalogs[kind],fileInput=useRef<HTMLInputElement>(null);
 const [selected,setSelected]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false),[pending,setPending]=useState<any>(null);
 const isPersona=kind==='persona',current=Object.fromEntries((isPersona?PERSONA_PRESET_KEYS:AUTONOMY_BUDGET_PRESET_KEYS).map((key:string)=>[key,value[key]])),matched=entries.find((entry:any)=>equal(entry.config,current)),chosen=entries.find((entry:any)=>entry.id===selected);
 function commit(config:any,label:string){onApply(config);setNotice('已载入'+label+'，可继续修改；确认后在页底保存。');setError('');setPending(null);}
 function load(config:any,label:string){if(dirty)setPending({config,label});else commit(config,label);}
 async function importFile(event:React.ChangeEvent<HTMLInputElement>){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;setLoading(true);setError('');setNotice('');
  try{if(file.size>PRESET_MAX_BYTES)throw Error('PRESET_FILE_TOO_LARGE');const data=parsePresetFile(await file.text(),kind);setSelected(entries.find((entry:any)=>equal(entry.config,data.config))?.id??'');load(data.config,data.name??'文件配置');}
  catch(reason:any){setError(errors[reason.message]??'导入失败，请检查JSON文件内容后重试。');}finally{setLoading(false);}
 }
 function exportCurrent(){try{const encoded=exportPresetFile(kind,extract(kind,value),{name:isPersona?current.name+'的人物配置':'自定义自主额度',description:isPersona?'人物五项配置，不包含主人档案。':'自主额度配置，不包含唤醒频率、权限或手机绑定。'});ui.download(JSON.parse(encoded),isPersona?'human-persona.json':'human-autonomy-budget.json');setError('');setNotice('已导出当前表单，可编辑JSON后再次导入。');}catch(reason:any){setError(errors[reason.message]??'当前表单暂不能导出，请先补全必填字段。');}}
 return <section className="hn-preset-picker" aria-label={isPersona?'人物预设':'自主额度预设'}>
  <div className="hn-row hn-between"><div><h4>{isPersona?'从人物预设开始':'选择一档自主额度'}</h4><p>{isPersona?'四种不同的相处风格，也可以完全自行配置。':'三档上限均可继续调整，先载入表单，保存后生效。'}</p></div><span className="hn-preset-current">表单方案：{matched?.name??'自行配置'}</span></div>
  <div className="hn-preset-controls"><Select aria-label={isPersona?'选择人物预设':'选择自主额度预设'} value={selected} onChange={(id:string)=>{setSelected(id);setNotice('');setError('');}} options={[["","自行配置"],...entries.map((entry:any)=>[entry.id,entry.name])]}/><Button disabled={!chosen||loading} onClick={()=>load(chosen.config,chosen.name)}>载入到表单</Button><div className="hn-preset-file-actions"><Button disabled={loading} onClick={()=>fileInput.current?.click()}>{loading?'正在读取…':'导入JSON'}</Button><Button onClick={exportCurrent}>导出当前表单</Button><input ref={fileInput} type="file" tabIndex={-1} accept=".json,application/json" className="hn-sr-only" aria-label={isPersona?'导入人物JSON文件':'导入额度JSON文件'} onChange={importFile}/></div></div>
  {chosen?<div className="hn-preset-preview"><p>{chosen.description}</p>{isPersona?<details><summary>查看人物预设细节</summary><dl>{[['role','关系与角色'],['corePrompt','核心人格'],['interests','兴趣'],['goals','长期方向']].map(([key,label])=><div key={key}><dt>{label}</dt><dd>{chosen.config[key]}</dd></div>)}</dl></details>:<dl className="hn-preset-budget-summary"><div><dt>预留token</dt><dd>{num(chosen.config.tokenLimit)}</dd></div><div><dt>模型请求</dt><dd>{num(chosen.config.requestLimit)}次</dd></div><div><dt>自主轮次</dt><dd>{num(chosen.config.roundLimit)}轮</dd></div><div><dt>周期与单轮时限</dt><dd>{period[chosen.config.budgetWindow]} · {chosen.config.roundTimeoutMs/60000}分钟</dd></div></dl>}</div>:<p className="hn-preset-help">{isPersona?'直接编辑下方人物字段即可。导入与导出仅包含人物设定，不包含你的称呼、城市等主人资料。':'直接编辑额度字段即可。选用档位不改变自主启用状态、检查间隔、静默时段或已有授权。'}</p>}
  {!isPersona&&<p className="hn-preset-help">任一启用的上限耗尽即等待补额或下个周期；预留token用于保守准入，不代表实际账单。主人主动聊天不受自主池限制。</p>}
  {isPersona&&<p className="hn-preset-help">仅替换名字、角色、人格、兴趣与长期方向；原会话、记忆、主人资料和手机绑定继续保留。</p>}
  {notice&&<p className="hn-preset-feedback" role="status">{notice}</p>}{error&&<p className="hn-preset-error" role="alert">{error}</p>}
  {pending&&<Detail title={isPersona?'替换人物配置草稿？':'替换自主额度草稿？'} onClose={()=>setPending(null)}><p>{isPersona?'将以所选配置替换当前人物五项草稿。你的称呼、城市等主人资料会保留。':'将替换当前额度相关草稿。已修改的其他自主行为设置会保留。'}此步骤只更新表单，仍需要另行保存。</p><div className="hn-row hn-dialog-actions"><Button onClick={()=>setPending(null)}>继续编辑</Button><Button primary onClick={()=>commit(pending.config,pending.label)}>载入并替换草稿</Button></div></Detail>}
 </section>;
}
