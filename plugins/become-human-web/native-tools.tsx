import React,{useEffect,useRef,useState} from 'react';
import {useDraftGuard,useDraftNavigation} from './native-shell';

const statusLabels:Record<string,string>={queued:'排队中','awaiting-approval':'等待本次批准',running:'执行中',suspended:'已暂停 · 保留进度',completed:'已完成',failed:'失败 · 不自动重试',cancelled:'已取消',expired:'授权已到期',unknown:'结果待核对 · 不自动重试'};
const rowsOf=(data:any)=>Array.isArray(data)?data:Array.isArray(data?.items)?data.items:[];
const catalogOf=(data:any)=>Array.isArray(data)?data:Array.isArray(data?.items)?data.items:Array.isArray(data?.tools)?data.tools:[];
const time=(value:any)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const print=(value:any)=>typeof value==='string'?value:JSON.stringify(value,null,2);
const previewStyle:any={whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'none'};
const fieldLabels:Record<string,string>={url:'网页地址',sessionId:'DSH 会话 ID',targetId:'浏览器标签页 ID',expectedOrigin:'目标页面当前来源',text:'文本内容',selector:'元素 CSS 选择器',replace:'替换输入框已有文字',limit:'最多读取条数',beforeSeq:'读取此序号之前的消息',throughSeq:'截至此消息序号',maxChars:'最多读取字符数',title:'报告标题',noteIds:'学习笔记 ID'};
const fieldHints:Record<string,string>={expectedOrigin:'填写当前页面的协议、域名与端口，例如 https://example.com。执行前会核对，页面已变化时停止操作。',targetId:'使用浏览器工具返回的精确标签页 ID，并先在“工具与连接”中授权。',sessionId:'填写已在“工具与连接”中明确授权的外部 DSH 会话 ID。',selector:'需要唯一匹配一个可见元素；匹配不到或出现多个结果时停止操作。'};
const schemaFields=(schema:any)=>Object.entries(schema?.properties??{}) as [string,any][];
const supported=(schema:any):boolean=>schema?.type==='object'&&schemaFields(schema).every(([,field])=>['string','integer','number','boolean','object'].includes(field.type)||field.type==='array'&&field.items?.type==='string'||Array.isArray(field.enum));
const initialInput=(schema:any)=>Object.fromEntries(schemaFields(schema).filter(([,field])=>field.default!==undefined||field.type==='boolean').map(([key,field])=>[key,field.default??false]));

function normalizeInput(schema:any,value:any){
  const input:any={};
  for(const [key,field] of schemaFields(schema)){
    const raw=value[key],required=(schema.required??[]).includes(key),label=field.title??fieldLabels[key]??key;
    if(raw===undefined||raw===''){if(required)throw new Error('请填写“'+label+'”。');continue;}
    let parsed=raw;
    if(['integer','number'].includes(field.type)){
      parsed=Number(raw);
      if(!Number.isFinite(parsed)||field.type==='integer'&&!Number.isSafeInteger(parsed))throw new Error('“'+label+'”需要填写'+(field.type==='integer'?'整数':'数字')+'。');
      if(field.minimum!==undefined&&parsed<field.minimum||field.maximum!==undefined&&parsed>field.maximum)throw new Error('“'+label+'”超出允许范围。');
    }
    if(field.type==='boolean'&&typeof parsed!=='boolean')throw new Error('请确认“'+label+'”。');
    if(field.type==='string'){
      parsed=String(raw);
      if(required&&!parsed.trim())throw new Error('请填写“'+label+'”。');
      if(field.minLength!==undefined&&parsed.length<field.minLength||field.maxLength!==undefined&&parsed.length>field.maxLength)throw new Error('“'+label+'”长度不符合要求。');
    }
    if(field.type==='array'){
      parsed=Array.isArray(raw)?raw:String(raw).split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
      if(!parsed.every((item:any)=>typeof item==='string')||field.minItems!==undefined&&parsed.length<field.minItems||field.maxItems!==undefined&&parsed.length>field.maxItems)throw new Error('“'+label+'”的项目数量或格式不正确。');
    }
    if(field.type==='object'){
      try{parsed=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new Error('“'+label+'”需要填写有效的 JSON 对象。');}
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('“'+label+'”需要填写 JSON 对象。');
    }
    if(Array.isArray(field.enum)&&!field.enum.includes(parsed))throw new Error('请重新选择“'+label+'”。');
    input[key]=parsed;
  }
  return input;
}

function ToolFields({schema,value,onChange,disabled,ui}:any){
  const {Field,Input,Text,Select,Check}=ui;
  return <div className="hn-fields">{schemaFields(schema).map(([key,field])=>{
    const label=(field.title??fieldLabels[key]??key)+((schema.required??[]).includes(key)?' *':''),hint=field.description??fieldHints[key];
    if(Array.isArray(field.enum))return <Field key={key} label={label} hint={hint}><Select disabled={disabled} value={value[key]===undefined?'':String(value[key])} options={[["","请选择"],...field.enum.map((item:any)=>[String(item),String(item)])]} onChange={(next:string)=>onChange(key,next===''?undefined:field.enum.find((item:any)=>String(item)===next))}/></Field>;
    if(field.type==='boolean')return <Field key={key} label={label} hint={hint}><Check label="启用此选项" disabled={disabled} value={value[key]} onChange={(next:boolean)=>onChange(key,next)}/></Field>;
    if(['integer','number'].includes(field.type))return <Field key={key} label={label} hint={hint}><input className="hn-input" type="number" disabled={disabled} min={field.minimum} max={field.maximum} step={field.type==='integer'?1:'any'} value={value[key]??''} onChange={event=>onChange(key,event.target.value)}/></Field>;
    if(field.type==='array')return <Field key={key} label={label+' · 每行一项'} hint={hint} wide><Text disabled={disabled} value={Array.isArray(value[key])?value[key].join('\n'):value[key]??''} rows={3} onChange={(next:string)=>onChange(key,next)}/></Field>;
    if(field.type==='object')return <Field key={key} label={label+' · JSON 对象'} hint={hint} wide><Text disabled={disabled} value={typeof value[key]==='object'?JSON.stringify(value[key],null,2):value[key]??''} rows={5} onChange={(next:string)=>onChange(key,next)}/></Field>;
    return <Field key={key} label={label} hint={hint} wide={field.maxLength>300||key==='text'}>{field.maxLength>300||key==='text'?<Text disabled={disabled} value={value[key]??''} maxLength={field.maxLength} rows={3} onChange={(next:string)=>onChange(key,next)}/>:<Input disabled={disabled} value={value[key]??''} maxLength={field.maxLength} placeholder={field.format==='uri'?'https://…':undefined} onChange={(next:string)=>onChange(key,next)}/>}</Field>;
  })}</div>;
}

function ToolSubmit({descriptor,api,s,busy,ui,onSubmitted}:any){
  const {Button,Band,JsonDetails}=ui,[input,setInput]=useState<any>(()=>initialInput(descriptor.inputSchema)),pending=useRef<any>(null);
  const signature=JSON.stringify(input),dirty=signature!==JSON.stringify(initialInput(descriptor.inputSchema));useDraftGuard(dirty);
  const canRender=supported(descriptor.inputSchema),available=descriptor.available!==false;
  const submit=()=>api.run(async()=>{
    const normalized=normalizeInput(descriptor.inputSchema,input),key=JSON.stringify([descriptor.id,normalized]);
    if(pending.current?.key!==key)pending.current={key,requestId:crypto.randomUUID()};
    await api.control({op:'tool-submit',tool:descriptor.id,input:normalized,requestId:pending.current.requestId});
    pending.current=null;setInput(initialInput(descriptor.inputSchema));onSubmitted();
  },descriptor.effect==='write'?'已生成待批准任务，请核对目标和参数后批准这一笔':s.desired==='running'?'已加入唯一执行队列':'已排队，恢复 Human 后执行');
  return <section className="hn-group"><h3>{descriptor.title??descriptor.description??descriptor.id}</h3><p className="hn-note hn-mono">{descriptor.id} · {descriptor.backend??'内置'} · {descriptor.effect==='write'?'写入或外部操作 · 逐笔批准':'只读'}</p>
    {descriptor.title&&descriptor.description&&<p className="hn-help">{descriptor.description}</p>}
    <p className="hn-note">单次超时 {Math.round((descriptor.timeoutMs??0)/1000)} 秒 · 结果上限 {descriptor.maxResultBytes??'—'} 字节 · {descriptor.autonomous?'允许自主任务提出调用':'仅手动提交'}</p>
    {descriptor.scope&&<JsonDetails value={descriptor.scope} label="查看本项允许范围"/>}
    {!available&&<Band>当前不可用：{ui.errorText(descriptor.unavailableReason??'请在设置 → 工具与连接中配置范围。')}</Band>}
    {canRender?<ToolFields schema={descriptor.inputSchema} value={input} onChange={(key:string,next:any)=>setInput((previous:any)=>({...previous,[key]:next}))} disabled={busy} ui={ui}/>:<Band>当前参数类型尚不能在此表单中编辑。请查看能力描述；本页不会猜测或提交未支持的参数。</Band>}
    {descriptor.effect==='write'&&<Band>提交仅生成预览。需要你核对完整目标与参数、逐笔批准后，才由唯一执行通道操作。批准不会扩大现有连接范围。</Band>}
    <Button primary disabled={busy||!available||!canRender} onClick={submit}>{descriptor.effect==='write'?'生成本次操作预览':'提交只读任务'}</Button>
  </section>;
}

function ToolResult({result,ui}:any){
  const {Band}=ui;
  if(result===undefined||result===null)return <Band>尚无可用结果。请查看任务状态与原因。</Band>;
  if(typeof result==='object'&&typeof result.excerpt==='string')return <>{result.fetchedAt&&<p className="hn-note">读取时间：{time(result.fetchedAt)}</p>}{result.digest&&<p className="hn-mono">正文 SHA-256：{result.digest}</p>}{result.comparison&&<Band>{!result.comparison.baselineExists?'已建立首次成功读取基线':result.comparison.changed?'提取正文有变化':'提取正文指纹未变化'}。这不是语义差异分析。</Band>}<Band>{result.partial?'当前为部分摘录':'已提取可用正文'}；内容尚未经知识结论验证。</Band><pre className="hn-preview" style={previewStyle}>{result.excerpt}</pre></>;
  return <pre className="hn-preview" style={previewStyle}>{print(result)}</pre>;
}

function PreparedPreview({row,ui}:any){
  const {Band}=ui,prepared=row.prepared,isReport=row.tool==='write-learning-report'||row.capabilitySnapshot?.backend==='managed-report';
  if(!prepared)return isReport?<Band>尚未取得完整文件预览，不能批准保存。请刷新任务。</Band>:null;
  if(isReport)return <section className="hn-group"><h3>准备写入的实际文件</h3><p className="hn-mono" style={previewStyle}>{prepared.path??'未取得写入路径'}</p><p className="hn-mono" style={previewStyle}>文件内容 SHA-256：{prepared.digest??'—'} · {prepared.bytes??'—'} 字节</p><p className="hn-note">下方是本次批准绑定的完整报告原文。文件内容摘要与上方任务预览摘要用途不同，均需保持一致。</p>{typeof prepared.content==='string'&&prepared.content.length?<pre className="hn-preview" style={previewStyle}>{prepared.content}</pre>:<Band>未取得完整报告原文，不能批准保存。</Band>}</section>;
  return <section className="hn-group"><h3>本次操作的完整预览</h3><pre style={previewStyle}>{print(prepared)}</pre></section>;
}

function ToolJob({row,api,busy,ui,onChanged}:any){
  const {Button,Check,Band,JsonDetails}=ui,[reviewed,setReviewed]=useState(''),approvalKey=JSON.stringify([row.id,row.version,row.digest]),expiryValue=row.approvalExpires??row.expires,expires=expiryValue?new Date(expiryValue).getTime():0,expired=expires>0&&expires<=Date.now();
  const isReport=row.tool==='write-learning-report'||row.capabilitySnapshot?.backend==='managed-report',prepared=row.prepared,hasReportPreview=!isReport||typeof prepared?.content==='string'&&prepared.content.length>0&&typeof prepared?.path==='string'&&prepared.path.length>0&&/^[a-f0-9]{64}$/i.test(prepared?.digest??'')&&Number.isSafeInteger(prepared?.bytes)&&prepared.bytes>0;
  const approve=()=>api.run(async()=>{await api.control({op:'tool-approve',jobId:row.id,expectedVersion:row.version,digest:row.digest});setReviewed('');onChanged();},'只批准了当前版本的这一笔操作，等待唯一执行通道');
  const cancel=()=>api.run(async()=>{await api.control({op:'tool-cancel',jobId:row.id,expectedVersion:row.version});onChanged();},'任务已取消');
  return <><Band>{statusLabels[row.status]??row.status} · 版本 {row.version} · 更新 {time(row.updated)}</Band><p className="hn-mono">{row.tool} · {row.id}</p><h3>本次目标与完整参数</h3><pre style={previewStyle}>{print(row.input)}</pre>
    {row.digest&&<p className="hn-mono">完整任务预览 SHA-256：{row.digest}</p>}{row.approvalExpires?<p className="hn-note">本次批准有效至：{time(row.approvalExpires)}</p>:row.expires?<p className="hn-note">任务预览保留至：{time(row.expires)}</p>:null}
    <PreparedPreview row={row} ui={ui}/>
    {row.status==='awaiting-approval'&&<><Band>请核对上方目标、完整参数{isReport?'、文件路径与完整报告原文':''}和当前版本。批准只作用于这一笔，不授权后续其他操作。{expired?'这份预览已到期，请重新检查任务。':''}</Band><Check label={isReport?'我已核对完整报告原文、写入路径与参数，批准保存当前版本':'我已核对目标和参数，批准执行当前版本的这一笔操作'} value={reviewed===approvalKey} disabled={busy||expired||!row.digest||!hasReportPreview} onChange={(checked:boolean)=>setReviewed(checked?approvalKey:'')}/><div className="hn-row"><Button primary disabled={busy||expired||!row.digest||!hasReportPreview||reviewed!==approvalKey} onClick={approve}>批准这一笔操作</Button></div></>}
    {row.status==='unknown'&&<Band>操作可能已经发生，但未取得确定回执。请先人工核对目标页面或会话；此任务不会自动重试，本页也不会重新提交。</Band>}
    {row.error&&<Band>原因：{ui.errorText(typeof row.error==='string'?row.error:row.error.code??row.error.message??print(row.error))}</Band>}
    {row.capabilitySnapshot&&<JsonDetails value={row.capabilitySnapshot} label="提交时的能力与范围快照"/>}
    {['queued','awaiting-approval','suspended','failed'].includes(row.status)&&<Button danger disabled={busy} onClick={cancel}>取消任务</Button>}
    <h3 className="hn-section-title">执行结果</h3><ToolResult result={row.result} ui={ui}/>
  </>;
}

function ToolJobDetail({id,api,busy,ui,nonce,onChanged,onClose}:any){
  const {Detail,Button,ReadState,useRead}=ui,result=useRead(api,{kind:'tool-job',jobId:id},nonce);
  return <Detail title="工具任务 · 目标、批准与回执" onClose={onClose}><Button disabled={busy} onClick={onChanged}>刷新当前任务</Button><ReadState result={result}>{(row:any)=><ToolJob key={row.id+':'+row.version+':'+row.digest} row={row} {...{api,busy,ui,onChanged}}/>}</ReadState></Detail>;
}

export default function Tools({api,s,busy,ui}:any){
  const {Button,Select,Field,Band,Empty,ReadState,useRead}=ui,[tool,setTool]=useState(''),[nonce,setNonce]=useState(0),[activeId,setActiveId]=useState(''),[filter,setFilter]=useState(''),navigation=useDraftNavigation(),lastCatalog=useRef<any[]>([]);
  const revision=Number(s.management?.toolRevision??0),rows=useRead(api,{kind:'tool-jobs',limit:50},nonce+revision),catalog=useRead(api,{kind:'tool-catalog'},nonce);if(catalog.data&&!catalog.error)lastCatalog.current=catalogOf(catalog.data);
  const items=lastCatalog.current,selected=items.find((item:any)=>item.id===tool);
  useEffect(()=>{if(!tool&&items.length)setTool((items.find((item:any)=>item.available!==false)??items[0]).id);},[tool,catalog.data]);
  const refresh=()=>setNonce(value=>value+1);
  return <><div className="hn-row hn-between"><h3>工具与能力</h3><Button disabled={busy} onClick={refresh}>刷新能力与任务</Button></div><Band>所有任务与聊天、学习共用唯一执行通道。只读工具按已配置范围读取；写入和浏览器操作需要逐笔预览批准。工具结果不会自动成为长期记忆。</Band>
    <ReadState result={catalog}>{()=>items.length?<Field label="选择能力"><Select value={tool} options={items.map((item:any)=>[item.id,(item.title??item.description??item.id)+(item.available===false?' · 未启用':'')])} onChange={(next:string)=>{if(next!==tool)navigation?.navigate?navigation.navigate(()=>setTool(next)):setTool(next);}}/></Field>:<Empty>暂无已注册能力。</Empty>}</ReadState>
    {selected&&<ToolSubmit key={selected.id} descriptor={selected} api={api} s={s} busy={busy||catalog.loading||!!catalog.error} ui={ui} onSubmitted={refresh}/>}
    <h3 className="hn-section-title">任务与回执</h3><Field label="筛选任务状态"><Select value={filter} options={[["","全部状态"],...Object.entries(statusLabels)]} onChange={setFilter}/></Field>
    <ReadState result={rows}>{(data:any)=>{const visible=rowsOf(data).filter((row:any)=>!filter||row.status===filter);return visible.length?visible.map((row:any)=><section className="hn-group" key={row.id}><div className="hn-row hn-between"><strong>{row.capabilitySnapshot?.title??row.tool}</strong><span>{statusLabels[row.status]??row.status}</span></div><p className="hn-note">{time(row.updated)} · 版本 {row.version}</p><p className="hn-mono" style={previewStyle}>{print(row.input)}</p>{row.error&&<p className="hn-note">原因：{ui.errorText(typeof row.error==='string'?row.error:row.error.code??row.error.message??print(row.error))}</p>}<Button onClick={()=>setActiveId(row.id)}>{row.status==='awaiting-approval'?'预览目标 / 批准':'查看结果与回执'}</Button></section>):<Empty>暂无符合条件的工具任务。</Empty>;}}</ReadState>
    {activeId&&<ToolJobDetail key={activeId} id={activeId} {...{api,busy,ui}} nonce={nonce+revision} onChanged={refresh} onClose={()=>setActiveId('')}/>}
  </>;
}
