import React,{useState} from 'react';

const labels:any={proposed:'待预览批准',approved:'已批准 · 等待执行',executing:'正在写入',completed:'已生成文件',blocked:'等待处理',cancelled:'已取消',expired:'已到期'};
const time=(n:any)=>n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'—';
const rowsOf=(data:any)=>Array.isArray(data)?data:Array.isArray(data?.items)?data.items:[];
const textStyle:any={whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'none'};

export function NotePicker({api,ui,selected,onChange,disabled=false}:any){
  const {Button,Check,Band,Empty,ReadState,useRead}=ui;
  const [nonce,setNonce]=useState(0),result=useRead(api,{kind:'action-notes'},nonce);
  const toggle=(id:string,checked:boolean)=>onChange(checked?[...selected,id]:selected.filter((value:string)=>value!==id));
  return <section className="hn-group"><div className="hn-row hn-between"><strong>选择有效学习笔记 · 最多 8 份</strong><Button disabled={disabled} onClick={()=>setNonce(n=>n+1)}>刷新材料</Button></div>
    <p className="hn-note">仅列出当前来源和记忆仍有效的笔记，提交时会再次核验。</p>
    <ReadState result={result}>{(data:any)=>{const notes=rowsOf(data).filter((n:any)=>n.eligible===true);return !notes.length?<Empty>暂无可用的学习笔记。可先完成一个学习步骤。</Empty>:notes.map((n:any)=><div className="hn-line" key={n.id}><div className="hn-grow"><Check label={n.title??n.data?.title??n.id} value={selected.includes(n.id)} disabled={disabled||!selected.includes(n.id)&&selected.length>=8} onChange={(checked:boolean)=>toggle(n.id,checked)}/>{n.summary&&<p>{n.summary}</p>}<p className="hn-note hn-mono" style={textStyle}>{n.id}</p>{n.source?.url&&<a className="hn-link" href={n.source.url} target="_blank" rel="noreferrer">查看来源 ↗</a>}</div></div>);}}</ReadState>
    {selected.length>0&&<Band>已选 {selected.length} 份。<div className="hn-note hn-mono" style={textStyle}>{selected.join('\n')}</div></Band>}
  </section>;
}

function ArtifactContent({api,id,ui}:any){
  const {Button,ReadState,useRead}=ui,result=useRead(api,{kind:'action-content',actionId:id}),[copied,setCopied]=useState('');
  const copy=async(markdown:string)=>{try{if(!navigator.clipboard)throw new Error('CLIPBOARD_UNAVAILABLE');await navigator.clipboard.writeText(markdown);setCopied('已复制实际文件内容。');}catch{setCopied('复制未完成，可在下方原文中选择并复制。');}};
  return <ReadState result={result}>{(file:any)=><section className="hn-group"><h3>实际文件原文</h3><p className="hn-note hn-mono" style={textStyle}>{file.path}</p><p className="hn-note hn-mono" style={textStyle}>SHA-256 {file.digest} · {file.bytes} 字节</p><Button onClick={()=>copy(file.markdown)}>复制实际文件内容</Button>{copied&&<p role="status">{copied}</p>}<pre className="hn-preview" style={textStyle}>{file.markdown}</pre></section>}</ReadState>;
}

function ActionPreviewContent({api,action,ui,onChanged}:any){
  const {Button,Check,Band}=ui,[reviewedDigest,setReviewedDigest]=useState(''),[showFile,setShowFile]=useState(false),[copied,setCopied]=useState('');
  const busy=!!api.snapshot.busy,content=typeof action.content==='string'?action.content:'',digest=typeof action.digest==='string'?action.digest:'',hasPreview=content.length>0&&/^[a-f0-9]{64}$/i.test(digest)&&Number.isSafeInteger(action.bytes)&&action.bytes>0;
  const approvalReady=action.status==='proposed'&&action.sourceValid===true&&hasPreview&&reviewedDigest===digest&&(!action.expires||action.expires>Date.now());
  const cancelable=['proposed','approved','blocked'].includes(action.status),receipt=action.receipt;
  const run=(op:string,notice:string)=>api.run(async()=>{await api.control({op,actionId:action.id,expectedVersion:action.version,digest});setReviewedDigest('');onChanged();},notice);
  const copy=async(text:string)=>{try{if(!navigator.clipboard)throw new Error('CLIPBOARD_UNAVAILABLE');await navigator.clipboard.writeText(text);setCopied('已复制报告草稿。');}catch{setCopied('复制未完成，可在报告原文中选择并复制。');}};
  return <><h3>{action.title}</h3><Band>{labels[action.status]??action.status} · 版本 {action.version} · 创建 {time(action.created)}{action.expires?' · 到期 '+time(action.expires):''}</Band>
    <p className="hn-note hn-mono" style={textStyle}>行动编号 {action.id}</p>
    {action.goal&&<p className="hn-note hn-mono" style={textStyle}>关联目标 {typeof action.goal==='string'?action.goal:action.goal.id??action.goal.goalId} {action.goal.stepId?'· 步骤 '+action.goal.stepId:''}</p>}
    <h3>本次准备写入的文件</h3><p className="hn-mono" style={textStyle}>{action.path}</p><p className="hn-note hn-mono" style={textStyle}>SHA-256 {digest||'—'} · {action.bytes??'—'} 字节</p>
    <h3>材料笔记编号</h3><div className="hn-note hn-mono" style={textStyle}>{(action.noteIds??[]).join('\n')||'—'}</div>
    {action.annotationScope&&<Band>{action.annotationScope}</Band>}
    {Array.isArray(action.ownerAnnotations)&&action.ownerAnnotations.length>0&&<p className="hn-note">本报告收录 {action.ownerAnnotations.length} 份人工批注：{action.ownerAnnotations.map((annotation:any)=>'v'+annotation.version+'（'+time(annotation.time)+'）').join('；')}。批注与原始学习结论分别展示。</p>}
    {action.sourceValid!==true&&<Band>当前材料已失效或尚未完成核验，不能批准此版本。请查看来源笔记后重新生成。</Band>}
    {action.reason&&<Band>等待原因：{ui.errorText(action.reason)}</Band>}
    {action.status==='approved'&&<Band>已批准这份具体内容。{action.approvalExpires?'本次授权有效至 '+time(action.approvalExpires)+'。':''}全局或自主暂停仍保留；恢复运行且轮到本行动后，才由当前唯一执行通道写入。</Band>}
    {hasPreview?<><div className="hn-row hn-between"><h3>完整 Markdown 原文</h3><Button onClick={()=>copy(content)}>复制报告草稿</Button></div>{copied&&<p role="status">{copied}</p>}<pre className="hn-preview" style={textStyle}>{content}</pre></>:<Band>未取得完整报告原文，无法批准。请刷新预览。</Band>}
    {action.status==='proposed'&&<><Check label="我已核对完整原文、材料编号和写入路径，批准写入这一版本" value={!!digest&&reviewedDigest===digest} disabled={busy||!hasPreview||action.sourceValid!==true} onChange={(checked:boolean)=>setReviewedDigest(checked?digest:'')}/><p className="hn-note">批准绑定当前版本和 SHA-256；内容变化后需要重新预览确认。</p></>}
    <div className="hn-row">{action.status==='proposed'&&<Button primary disabled={busy||!approvalReady} onClick={()=>run('action-approve','已批准当前报告版本，等待原执行通道处理')}>批准此版本写入</Button>}{cancelable&&<Button danger disabled={busy} onClick={()=>run('action-cancel','行动已取消')}>取消此行动</Button>}</div>
    {receipt&&<section className="hn-group"><h3>实际写入回执</h3><p className="hn-mono" style={textStyle}>{receipt.path}</p><p className="hn-note hn-mono" style={textStyle}>SHA-256 {receipt.digest??receipt.sha256} · {receipt.bytes} 字节</p><p className="hn-note">完成 {time(receipt.completedAt??receipt.created)}。该回执表示受管文件已经写入并核验，不代表现实效果已经验证。</p><Button onClick={()=>setShowFile(v=>!v)}>{showFile?'收起实际文件原文':'查看实际文件原文 / 复制'}</Button>{showFile&&<ArtifactContent api={api} id={action.id} ui={ui}/>}</section>}
  </>;
}

export function ActionDetail({api,id,onClose,ui,onChanged}:any){
  const {Detail,Button,ReadState,useRead}=ui,[nonce,setNonce]=useState(0),result=useRead(api,{kind:'action',actionId:id},nonce+Number(api.snapshot.state?.management?.actionRevision??0));
  const changed=()=>{setNonce(n=>n+1);onChanged?.();};
  return <Detail title="报告行动 · 完整预览与精确批准" onClose={onClose}><Button onClick={changed}>刷新预览</Button><ReadState result={result}>{(action:any)=><ActionPreviewContent key={action.id+':'+action.version+':'+action.digest} api={api} action={action} ui={ui} onChanged={changed}/>}</ReadState></Detail>;
}

function ReportCreate({api,ui,onCreated,onClose}:any){
  const {Detail,Button,Field,Input,Band}=ui,[title,setTitle]=useState(''),[noteIds,setNoteIds]=useState<string[]>([]),[requestId]=useState(()=>crypto.randomUUID());
  return <Detail title="从学习笔记生成报告草稿" onClose={onClose}><Band>将所选笔记整理为受管 Markdown 文件。先生成草稿，完整预览并批准后才会写入；创建草稿不会发布手机消息。</Band><Field label="报告标题"><Input value={title} maxLength={120} onChange={setTitle}/></Field><NotePicker api={api} ui={ui} selected={noteIds} onChange={setNoteIds} disabled={api.snapshot.busy}/><Button primary disabled={api.snapshot.busy||!title.trim()||!noteIds.length||noteIds.length>8} onClick={()=>api.run(async()=>{const action=await api.control({op:'action-propose-report',requestId,title:title.trim(),noteIds});onCreated(action?.id??action?.action?.id??action?.actionId??'');},'报告草稿已生成，请预览后决定是否批准')}>生成待批准草稿</Button></Detail>;
}

export default function Actions({api,s,busy,ui}:any){
  const {Button,Select,Band,Empty,ReadState,useRead}=ui,[nonce,setNonce]=useState(0),[status,setStatus]=useState(''),[creating,setCreating]=useState(false),[active,setActive]=useState(''),result=useRead(api,{kind:'actions'},nonce+Number(s.management?.actionRevision??0));
  const refresh=()=>setNonce(n=>n+1);
  return <><div className="hn-row hn-between"><h3>报告行动</h3><div className="hn-row"><Button onClick={refresh}>刷新行动</Button><Button primary disabled={busy} onClick={()=>setCreating(true)}>生成学习报告</Button></div></div>
    <Band>草稿、批准和实际写入分开记录。已批准的行动与聊天、学习共用唯一执行通道，主人输入优先；暂停状态下不会写入文件。</Band>
    <Select aria-label="筛选行动状态" value={status} options={[["","全部状态"],...Object.entries(labels)]} onChange={setStatus}/>
    <ReadState result={result}>{(data:any)=>{const rows=rowsOf(data).filter((a:any)=>!status||a.status===status);return !rows.length?<Empty>暂无符合条件的报告行动。可从有效学习笔记生成第一份草稿。</Empty>:rows.map((action:any)=><section className="hn-group" key={action.id}><div className="hn-row hn-between"><strong>{action.title}</strong><span>{labels[action.status]??action.status}</span></div><p className="hn-note">创建 {time(action.created)} · 版本 {action.version} · {(action.noteIds??[]).length} 份材料</p><p className="hn-note hn-mono" style={textStyle}>{action.receipt?.path??action.path}</p>{action.reason&&<p>等待原因：{ui.errorText(action.reason)}</p>}<Button onClick={()=>setActive(action.id)}>{action.status==='proposed'?'完整预览 / 批准':'查看行动 / 文件'}</Button></section>);}}</ReadState>
    {creating&&<ReportCreate api={api} ui={ui} onClose={()=>setCreating(false)} onCreated={(id:string)=>{setCreating(false);refresh();if(id)setActive(id);}}/>}{active&&<ActionDetail api={api} id={active} ui={ui} onClose={()=>setActive('')} onChanged={refresh}/>}</>;
}
