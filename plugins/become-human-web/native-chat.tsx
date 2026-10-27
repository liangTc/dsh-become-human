import React,{useEffect,useRef,useState} from 'react';
import {useDraftGuard} from './native-shell';
import {useRetainedRead} from './native-disclosure';
import {replyParts} from './runtime/reply-parts.mjs';
import css from './native-relationship-media.css';

export const imageLimits={perFile:5*1024*1024,total:12*1024*1024,count:4};
const imageTypes=new Set(['image/png','image/jpeg','image/webp']);
const bytes=(size:number)=>size>=1048576?(size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(size/1024))+' KB';
const errorText=(ui:any,error:any)=>ui.errorText?.(error?.message??error)??error?.message??'图片操作未完成';
type PhotoDraft={key:string;file:File;preview:string;status:'ready'|'uploading'|'uploaded'|'failed';attachment?:any;error?:string};

export function validImageHeader(mime:string,header:Uint8Array){
 if(mime==='image/png')return header.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>header[index]===value);
 if(mime==='image/jpeg')return header.length>=3&&header[0]===255&&header[1]===216&&header[2]===255;
 return mime==='image/webp'&&header.length>=12&&String.fromCharCode(...header.slice(0,4))==='RIFF'&&String.fromCharCode(...header.slice(8,12))==='WEBP';
}
export function imageSelectionError(file:Pick<File,'type'|'size'>,current:any[]){
 if(!imageTypes.has(file.type))return '请选择 PNG、JPEG 或 WebP 图片，暂不支持其他文件类型。';
 if(!file.size||file.size>imageLimits.perFile)return '每张图片需大于 0 字节且不超过 5 MB。';
 if(current.length>=imageLimits.count)return '每条消息最多添加 4 张图片。';
 if(current.reduce((sum,row)=>sum+(row.file?.size??row.size??0),0)+file.size>imageLimits.total)return '同一条消息的图片合计不能超过 12 MB。';
 return '';
}
const base64=(file:File)=>new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const result=String(reader.result??''),comma=result.indexOf(',');comma<0?reject(new Error('MEDIA_READ_FAILED')):resolve(result.slice(comma+1));};reader.onerror=()=>reject(new Error('MEDIA_READ_FAILED'));reader.onabort=()=>reject(new Error('MEDIA_READ_FAILED'));reader.readAsDataURL(file);});
const fromBase64=(value:string,mime:string)=>{const decoded=atob(value),data=new Uint8Array(decoded.length);for(let i=0;i<decoded.length;i++)data[i]=decoded.charCodeAt(i);return URL.createObjectURL(new Blob([data],{type:mime}));};

function SavedImage({api,attachment,sessionId,ui}:any){
 const [state,setState]=useState<any>({url:'',error:'',loading:true}),[nonce,setNonce]=useState(0),[open,setOpen]=useState(false),{Button,Detail}=ui;
 const id=attachment?.id,scope=String(sessionId)+':'+String(id);
 useEffect(()=>{let live=true,url='';setState({url:'',error:'',loading:true});
  if(typeof id!=='string'||!id||id.length>160){setState({url:'',error:'图片记录无效',loading:false});return;}
  api.read({kind:'media',id,sessionId}).then((value:any)=>{if(!live)return;const mime=value.mime??value.attachment?.mime;if(!imageTypes.has(mime)||typeof value.base64!=='string'||value.base64.length>7*1024*1024)throw new Error('MEDIA_CONTENT_INVALID');url=fromBase64(value.base64,mime);setState({url,error:'',loading:false});}).catch((error:any)=>{if(live)setState({url:'',error:errorText(ui,error),loading:false});});
  return ()=>{live=false;if(url)URL.revokeObjectURL(url);};
 },[api,scope,nonce]);
 return <div className="hn-saved-image">{state.url?<button type="button" className="hn-image-open" onClick={()=>setOpen(true)} aria-label={'查看图片：'+(attachment.name??'聊天图片')}><img src={state.url} alt={attachment.name??'聊天图片'} loading="lazy" onError={()=>setState((old:any)=>({...old,error:'图片暂时无法显示'}))}/></button>:<div className="hn-image-unavailable" role="status">{state.loading?'正在读取图片…':<>{state.error||'图片暂不可用'}<Button onClick={()=>setNonce(value=>value+1)}>重新读取</Button></>}</div>}
  {state.url&&state.error&&<p role="status" className="hn-note">{state.error}</p>}
  {open&&state.url&&<Detail title={attachment.name??'聊天图片'} onClose={()=>setOpen(false)}><img className="hn-image-full" src={state.url} alt={attachment.name??'聊天图片'}/></Detail>}
 </div>;
}

export default function NativeChat({api,s,busy,ui}:any){
 const {Button,Text}=ui,[text,setText]=useState(''),[photos,setPhotosState]=useState<PhotoDraft[]>([]),[photoError,setPhotoError]=useState(''),[choosing,setChoosing]=useState(false),[unread,setUnread]=useState(false),[capabilityNonce,setCapabilityNonce]=useState(0);
 const capability=useRetainedRead(api,{kind:'multimodal-status'},Number(s.management?.revision??0)+capabilityNonce),imageReady=capability.data?.images?.enabled===true&&capability.data?.route?.imageInput==='supported'&&capability.data?.route?.authoritative===true;
 const capabilityHint=capability.loading?'正在核对当前模型的图片能力…':capability.error?'暂时无法核对图片能力，请稍后重新读取。':capability.data?.route?.imageInput==='unsupported'?'当前对话模型只支持文字，请先在“模型与对话”切换支持图片的模型。':capability.data?.route?.imageInput==='unknown'?'当前对话模型尚未声明支持图片，请先在“模型与对话”核对图片输入能力。':capability.data?.route?.authoritative===false?'当前模型的图片输入能力尚未完成核验，请检查模型配置后重新核对。':!imageReady?'图片能力暂时不可用，请核对运行服务与模型设置。':'';
 const pending=useRef<any>(null),tail=useRef<HTMLDivElement>(null),follow=useRef(true),input=useRef<HTMLInputElement>(null),photosRef=useRef<PhotoDraft[]>([]),alive=useRef(true),choosingRef=useRef(false),sessionRef=useRef(s.sessionId);sessionRef.current=s.sessionId;
 const setPhotos=(rows:PhotoDraft[])=>{photosRef.current=rows;if(alive.current)setPhotosState(rows);};
 const updatePhoto=(key:string,patch:any)=>setPhotos(photosRef.current.map(row=>row.key===key?{...row,...patch}:row));
 useDraftGuard(!!text.trim()||photos.length>0);
 useEffect(()=>{alive.current=true;return ()=>{alive.current=false;for(const photo of photosRef.current)URL.revokeObjectURL(photo.preview);};},[]);
 useEffect(()=>{for(const photo of photosRef.current)URL.revokeObjectURL(photo.preview);setPhotos([]);setText('');setPhotoError('');pending.current=null;},[s.sessionId]);
 useEffect(()=>{if(follow.current)tail.current?.scrollIntoView({block:'end'});else setUnread(true);},[s.messages?.at(-1)?.seq]);
 async function choose(files:FileList|null){
  if(!files?.length||busy||choosingRef.current)return;choosingRef.current=true;setChoosing(true);setPhotoError('');const selectedSession=s.sessionId,accepted=[...photosRef.current],errors:string[]=[],createdUrls:string[]=[];let applied=false;
  try{for(const file of Array.from(files)){
   if(accepted.some(row=>row.file.name===file.name&&row.file.size===file.size&&row.file.lastModified===file.lastModified))continue;
   const invalid=imageSelectionError(file,accepted);if(invalid){errors.push(file.name+'：'+invalid);continue;}
   try{if(!validImageHeader(file.type,new Uint8Array(await file.slice(0,12).arrayBuffer()))){errors.push(file.name+'：图片内容与格式不一致，请重新选择。');continue;}}
   catch{errors.push(file.name+'：无法读取这张图片，请重新选择。');continue;}
   if(!alive.current||sessionRef.current!==selectedSession)return;const preview=URL.createObjectURL(file);createdUrls.push(preview);accepted.push({key:crypto.randomUUID(),file,preview,status:'ready'});
  }if(alive.current&&sessionRef.current===selectedSession){setPhotos(accepted);setPhotoError(errors.join(' '));applied=true;}}
  finally{if(!applied)for(const url of createdUrls)URL.revokeObjectURL(url);choosingRef.current=false;if(alive.current)setChoosing(false);if(input.current)input.current.value='';}
 }
 function remove(key:string){if(busy||choosingRef.current)return;const photo=photosRef.current.find(row=>row.key===key),unsubmitted=!pending.current;if(photo)URL.revokeObjectURL(photo.preview);setPhotos(photosRef.current.filter(row=>row.key!==key));pending.current=null;setPhotoError('');if(photo?.attachment&&unsubmitted)void api.control({op:'media-discard',sessionId:s.sessionId,id:photo.attachment.id}).catch(()=>{if(alive.current)setPhotoError('图片已从草稿移除，服务器清理尚未确认。');});}
 function send(){
  if(busy||choosingRef.current)return;const body=text.trim(),selected=photosRef.current.map(photo=>({...photo}));if(!body&&!selected.length)return;if(selected.length&&!imageReady){setPhotoError(capabilityHint||'当前模型暂不能接收图片。');return;}
  const selectedSession=s.sessionId;follow.current=true;setPhotoError('');void api.run(async()=>{
   for(const photo of selected){if(photo.attachment)continue;updatePhoto(photo.key,{status:'uploading',error:''});
    try{const encoded=await base64(photo.file);if(sessionRef.current!==selectedSession)throw new Error('STALE_SESSION');const value=await api.control({op:'media-upload',sessionId:selectedSession,name:photo.file.name,mime:photo.file.type,base64:encoded}),attachment=value?.attachment;
     if(!attachment?.id)throw new Error('MEDIA_UPLOAD_NOT_CONFIRMED');photo.attachment=attachment;updatePhoto(photo.key,{status:'uploaded',attachment});
    }catch(error:any){updatePhoto(photo.key,{status:'failed',error:errorText(ui,error)});throw error;}
   }
   const attachments=selected.map(photo=>({id:photo.attachment.id})),signature=JSON.stringify({text:body,attachments});
   if(sessionRef.current!==selectedSession)throw new Error('STALE_SESSION');
   if(pending.current?.signature!==signature)pending.current={signature,request:{text:body,sessionId:selectedSession,requestId:crypto.randomUUID(),...(attachments.length?{attachments}:{})}};
   await api.control({op:'message',...pending.current.request});pending.current=null;
   if(alive.current&&sessionRef.current===selectedSession){setText(current=>current.trim()===body?'':current);const sent=new Set(selected.map(photo=>photo.key));for(const photo of selected)URL.revokeObjectURL(photo.preview);setPhotos(photosRef.current.filter(photo=>!sent.has(photo.key)));}
  },'消息已发送，网页和手机共享本次对话');
 }
 const canSend=!!text.trim()||photos.length>0;
 return <><style>{css}</style><div className="hn-chat" onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;if(follow.current)setUnread(false);}}>
  <details className="hn-chat-context"><summary>网页与手机共享同一会话</summary><p className="hn-mono">会话编号：{s.sessionId}</p></details>
  {!s.messages?.length?<div className="hn-chat-empty"><div className="hn-empty-mark">H</div><h2>和{s.management.profile.name}说点什么</h2><p>从一件小事开始。手机和网页中的消息都会出现在这里。</p></div>:s.messages.map((message:any)=>{const body=message.displayText??message.text??'',parts=message.kind==='assistant'?(Array.isArray(message.bubbleParts)&&message.bubbleParts.length&&message.bubbleParts.every((part:any)=>typeof part==='string')?message.bubbleParts:replyParts(body,{enabled:s.management.execution.conversation?.replyBubbles!==false})):[body],attachments=Array.isArray(message.attachments)?message.attachments.slice(0,imageLimits.count):[];return <article className={'hn-message hn-'+message.kind} key={message.seq}><div className="hn-message-meta"><strong>{message.kind==='user'?'我':s.management.profile.name}</strong><time dateTime={new Date(message.created).toISOString()}>{new Date(message.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}</time></div>{attachments.length>0&&<div className="hn-message-images">{attachments.map((attachment:any)=><SavedImage key={s.sessionId+':'+attachment.id} {...{api,attachment,ui}} sessionId={s.sessionId}/>)}</div>}{parts.filter((part:string)=>!!part).map((part:string,index:number)=><div className="hn-bubble" key={message.seq+':'+index} data-reply-part={index}>{part}</div>)}</article>;})}
  <div ref={tail}/></div>{unread&&<div className="hn-unread"><Button onClick={()=>{follow.current=true;setUnread(false);tail.current?.scrollIntoView({block:'end'});}}>查看新消息 ↓</Button></div>}
  <div className="hn-compose"><div className="hn-compose-inner">
   {photos.length>0&&<div className="hn-image-drafts" aria-label="待发送图片">{photos.map(photo=><div className="hn-image-draft" key={photo.key}><img src={photo.preview} alt={'待发送：'+photo.file.name}/><div><strong title={photo.file.name}>{photo.file.name}</strong><small>{bytes(photo.file.size)} · {photo.status==='uploading'?'正在上传…':photo.status==='uploaded'?'上传完成，待发送':photo.status==='failed'?'上传未完成':'待发送'}</small>{photo.error&&<small className="hn-image-error">{photo.error}</small>}</div><Button aria-label={'移除图片：'+photo.file.name} disabled={busy||choosing} onClick={()=>remove(photo.key)}>移除</Button></div>)}</div>}
   {photoError&&<p className="hn-image-error" role="alert">{photoError}</p>}
   {photos.length>0&&capabilityHint&&<div role="status"><p className="hn-image-error">{capabilityHint}图片草稿已保留，也可以移除图片后只发送文字。</p>{(capability.error||capability.data?.route?.authoritative===false)&&<Button disabled={capability.loading} onClick={()=>setCapabilityNonce(value=>value+1)}>重新核对图片能力</Button>}</div>}
   {photos.length>0&&imageReady&&<p className="hn-note">图片用于本次消息；后续需要再次看图时，请重新附上图片。</p>}
   <Text aria-label="发送给 Human 的消息" value={text} onChange={setText} placeholder={'和'+s.management.profile.name+'说点什么，也可以发图片……'} rows={2} maxLength={1024} disabled={choosing} onKeyDown={(event:any)=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();send();}}}/>
   <div className="hn-compose-tools"><input ref={input} className="hn-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy||choosing||photos.length>=imageLimits.count} aria-label="选择聊天图片" onChange={event=>void choose(event.target.files)}/><Button disabled={busy||choosing||photos.length>=imageLimits.count} onClick={()=>input.current?.click()}>添加图片</Button><small>PNG / JPEG / WebP · 每张≤5 MB · 最多4张，总计≤12 MB</small></div>
   <div className="hn-row hn-between"><small>{s.desired==='paused'?'当前已暂停，发送的消息会排队，恢复后处理。':'Enter 发送 · Shift + Enter 换行 · 你的消息优先处理'}</small><Button primary disabled={busy||choosing||!canSend||photos.length>0&&!imageReady} onClick={send}>{busy&&photos.some(photo=>photo.status==='uploading')?'上传中…':'发送'} <span aria-hidden="true">↑</span></Button></div>
  </div></div></>;
}
