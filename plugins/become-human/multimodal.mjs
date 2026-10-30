// Human owns admission and session access; DSH owns image decoding, normalized
// immutable objects and provider wire transforms. No caller path/URL is used.
import {randomUUID} from 'node:crypto';
import {currentDialogueOwnerIndex} from './dialogue-frame.mjs';

export const mediaPolicy=Object.freeze({version:1,mimes:['image/png','image/jpeg','image/webp'],maxBytes:5*1024*1024,maxPerMessage:4,maxMessageBytes:12*1024*1024,maxStoredBytes:128*1024*1024,maxPending:20,pendingTtlMs:24*3600000});
export const runtimeAttachmentLimits=Object.freeze({maxImageBytes:mediaPolicy.maxBytes,maxImagesPerMessage:mediaPolicy.maxPerMessage,maxMessageImageBytes:mediaPolicy.maxMessageBytes,maxImagePixels:16000000,maxImageDimension:8192,normalizedImageMaxPixels:2000000,normalizedImageMaxBytes:3*1024*1024});
const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const fail=code=>{throw new Error(code);};
const parse=value=>{try{return JSON.parse(value);}catch{fail('MEDIA_RECORD_INVALID');}};
const clone=value=>structuredClone(value);
const validModalities=value=>Array.isArray(value)?[...new Set(value.filter(v=>v==='text'||v==='image'))]:null;
export function assertImageModel(inputModalities,imageCount){
  if(!imageCount)return;
  const modalities=validModalities(inputModalities);
  if(!modalities?.length)fail('MODEL_IMAGE_CAPABILITY_UNKNOWN');
  if(!modalities.includes('image'))fail('MODEL_IMAGE_INPUT_UNSUPPORTED');
}
export function imageContentCount(messages){return messages.reduce((count,message)=>count+(message.content??[]).filter(part=>part?.type==='image').length,0);}
export function estimateImageRequestCost(messages){
  // Neutral conservative estimate, not a supplier pricing claim. Base64 bytes
  // never enter the context byte meter or the request journal.
  return messages.reduce((total,message)=>total+(message.content??[]).reduce((sum,part)=>part?.type==='image'?sum+2048+Math.ceil(part.attachment.width/512)*Math.ceil(part.attachment.height/512)*256:sum,0),0);
}
export function attachCurrentImages(messages,agent,{admittedIds=[],inputModalities,requireCapability=true}={}){
  const images=agent.factory.media?.current(agent.id,admittedIds)??[];
  if(!images.length){if(imageContentCount(messages))fail('MEDIA_REQUEST_CONTEXT_INVALID');return messages;}
  if(requireCapability)assertImageModel(inputModalities,images.length);
  const target=currentDialogueOwnerIndex(messages)??messages.findLastIndex(message=>message.role==='user');
  if(target<0||messages[target]?.role!=='user')fail('MEDIA_REQUEST_CONTEXT_INVALID');
  const output=messages.map((message,index)=>{const content=message.content.filter(part=>part.type!=='image');return {...message,content:index===target?[...content,...images.map(row=>({type:'image',attachment:clone(row.ref)}))]:content};});
  for(const key of Object.getOwnPropertyNames(messages))if(!/^\d+$/u.test(key)&&key!=='length'&&key!=='mediaReport')Object.defineProperty(output,key,Object.getOwnPropertyDescriptor(messages,key));
  Object.defineProperty(output,'mediaReport',{value:{version:1,count:images.length,ids:images.map(row=>row.id),estimatedTokens:estimateImageRequestCost(output),scope:'current-admitted-owner-input-only'},enumerable:false});
  return output;
}
function descriptor(row){
  const ref=typeof row.ref==='string'?parse(row.ref):row.ref;
  return {id:row.id,kind:'image',mime:ref.mediaType,size:ref.bytes,width:ref.width,height:ref.height,name:ref.name??'图片',sha256:ref.attachmentId.slice(7)};
}
export class HumanMedia {
  constructor(journal,domain,attachments){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.attachments=attachments;journal.media=this;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_image_attachment(agent TEXT,id TEXT,ref TEXT NOT NULL,original_size INTEGER NOT NULL,message_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(agent,id));
      CREATE INDEX IF NOT EXISTS human_image_message ON human_image_attachment(agent,message_id,status);`);
  }
  ready(){if(typeof this.attachments?.saveImage!=='function'||typeof this.attachments?.readImage!=='function')fail('MEDIA_SERVICE_UNAVAILABLE');}
  row(agent,id){
    if(!idPattern.test(id??''))fail('MEDIA_NOT_FOUND');
    const row=this.db.prepare("SELECT * FROM human_image_attachment WHERE agent=? AND id=? AND status='active'").get(agent,id);
    if(!row||!row.message_id&&Date.now()-row.created>mediaPolicy.pendingTtlMs)fail('MEDIA_NOT_FOUND');
    if(row.message_id&&!this.domain.sourceUsable(agent,row.message_id))fail('MEDIA_SOURCE_UNAVAILABLE');
    return row;
  }
  async upload(agent,input){
    this.ready();this.journal.assertAdmitted(agent);
    if(!input||Object.keys(input).some(key=>!['op','sessionId','name','mime','base64'].includes(key)))fail('INVALID_MEDIA_UPLOAD');
    if(!mediaPolicy.mimes.includes(input.mime))fail('MEDIA_TYPE_UNSUPPORTED');
    if(typeof input.base64!=='string'||!input.base64.length||input.base64.length>Math.ceil(mediaPolicy.maxBytes/3)*4)fail('MEDIA_TOO_LARGE');
    if(input.base64.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.base64))fail('MEDIA_IMAGE_INVALID');
    const data=Buffer.from(input.base64,'base64');
    if(!data.length||data.length>mediaPolicy.maxBytes)fail('MEDIA_TOO_LARGE');
    if(data.toString('base64')!==input.base64)fail('MEDIA_IMAGE_INVALID');
    const stats=this.db.prepare("SELECT count(*) count,COALESCE(sum(original_size),0) bytes,COALESCE(sum(CASE WHEN message_id IS NULL AND created>? THEN 1 ELSE 0 END),0) pending FROM human_image_attachment WHERE agent=? AND status='active'").get(Date.now()-mediaPolicy.pendingTtlMs,agent);
    if(stats.bytes+data.length>mediaPolicy.maxStoredBytes||stats.pending>=mediaPolicy.maxPending)fail('MEDIA_STORAGE_LIMIT');
    if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.length>200))fail('INVALID_MEDIA_NAME');
    const name=(input.name??'图片').replace(/[\\/\u0000-\u001f\u007f]/gu,'_').slice(0,100);
    let ref;
    try{ref=await this.attachments.saveImage({data,mediaType:input.mime,name});}
    catch(error){if(/TOO_LARGE|LIMIT|PIXEL|DIMENSION/u.test(error.code??''))fail('MEDIA_TOO_LARGE');fail('MEDIA_IMAGE_INVALID');}
    if(!ref||!/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId??'')||!mediaPolicy.mimes.includes(ref.mediaType)||!Number.isSafeInteger(ref.bytes)||ref.bytes<=0||ref.bytes>mediaPolicy.maxBytes||!Number.isSafeInteger(ref.width)||!Number.isSafeInteger(ref.height)||ref.width<1||ref.height<1)fail('MEDIA_IMAGE_INVALID');
    const row={id:randomUUID(),ref:JSON.stringify(ref),original_size:data.length,created:Date.now()};
    this.db.prepare("INSERT INTO human_image_attachment VALUES(?,?,?,?,NULL,'active',?)").run(agent,row.id,row.ref,row.original_size,row.created);
    this.journal.audit(agent,'media-uploaded',{mediaId:row.id,mime:ref.mediaType,bytes:ref.bytes,width:ref.width,height:ref.height});
    return {attachment:descriptor(row)};
  }
  ids(input=[]){
    if(!Array.isArray(input)||input.length>mediaPolicy.maxPerMessage)fail('MEDIA_TOO_MANY');
    if(input.some(row=>!row||Object.keys(row).length!==1||!idPattern.test(row.id??'')))fail('INVALID_MEDIA_REFERENCE');
    const ids=input.map(row=>row.id);if(new Set(ids).size!==ids.length)fail('INVALID_MEDIA_REFERENCE');return ids;
  }
  validate(agent,ids,messageId){
    const rows=ids.map(id=>this.row(agent,id));
    if(rows.some(row=>row.message_id&&row.message_id!==messageId))fail('MEDIA_ALREADY_BOUND');
    if(rows.reduce((sum,row)=>sum+row.original_size,0)>mediaPolicy.maxMessageBytes)fail('MEDIA_MESSAGE_TOO_LARGE');
    return rows.map(row=>({id:row.id,ref:parse(row.ref)}));
  }
  bind(agent,ids,messageId){this.validate(agent,ids,messageId);for(const id of ids)this.db.prepare('UPDATE human_image_attachment SET message_id=? WHERE agent=? AND id=? AND message_id IS NULL').run(messageId,agent,id);}
  current(agent,messageIds){
    if(!Array.isArray(messageIds)||messageIds.length>16||messageIds.some(id=>typeof id!=='string'))fail('INVALID_MEDIA_MESSAGE_QUERY');
    const images=messageIds.flatMap(messageId=>{
      const rows=this.db.prepare("SELECT * FROM human_image_attachment WHERE agent=? AND message_id=? AND status='active' ORDER BY created,id").all(agent,messageId);
      if(rows.length&&!this.domain.sourceUsable(agent,messageId))fail('MEDIA_SOURCE_UNAVAILABLE');
      return rows.map(row=>({id:row.id,ref:parse(row.ref)}));
    });
    if(images.length>mediaPolicy.maxPerMessage)fail('MEDIA_TOO_MANY');return images;
  }
  messageContent(agent,messageId,text){
    // Admission creates the bound request before DomainMemory observes the
    // resulting session message. This private constructor is not a read API.
    const rows=this.db.prepare("SELECT ref FROM human_image_attachment WHERE agent=? AND message_id=? AND status='active' ORDER BY created,id").all(agent,messageId);
    return [...(text?[{type:'text',text}]:[{type:'text',text:'本条消息包含图片，用户未附文字。'}]),...rows.map(row=>({type:'image',attachment:parse(row.ref)}))];
  }
  messageDescriptors(agent,messageId){if(!messageId)return [];try{return this.current(agent,[messageId]).map(row=>descriptor(row));}catch{return [];}}
  async read(agent,id){
    this.ready();this.journal.assertAdmitted(agent);const row=this.row(agent,id),ref=parse(row.ref);
    let stored;try{stored=await this.attachments.readImage(ref);}catch{fail('MEDIA_IMAGE_UNAVAILABLE');}
    return {attachment:descriptor(row),mime:ref.mediaType,base64:Buffer.from(stored.data).toString('base64')};
  }
  discard(agent,id){const row=this.row(agent,id);if(row.message_id)fail('MEDIA_ALREADY_BOUND');this.db.prepare("UPDATE human_image_attachment SET status='discarded' WHERE agent=? AND id=?").run(agent,id);return {discarded:true};}
  export(agent){
    this.journal.assertAdmitted(agent);
    const totalStoredReferences=this.db.prepare("SELECT count(*) n FROM human_image_attachment WHERE agent=? AND message_id IS NOT NULL AND status='active'").get(agent).n;
    const scanned=this.db.prepare("SELECT * FROM human_image_attachment WHERE agent=? AND message_id IS NOT NULL AND status='active' ORDER BY created DESC,id DESC LIMIT 257").all(agent),rows=scanned.filter(row=>this.domain.sourceUsable(agent,row.message_id));
    return {version:1,images:rows.slice(0,256).reverse().map(row=>({messageId:row.message_id,attachment:descriptor(row)})),totalStoredReferences,scanned:scanned.length,truncated:totalStoredReferences>scanned.length||rows.length>256,includesBytes:false,restoreSemantics:'Bounded read-only managed references and display metadata, filtered by current source access. totalStoredReferences includes unavailable sources. This JSON is not an image backup and cannot restore image bytes or reactivate source access. Use the offline full-store backup for operational restore.'};
  }
  async route(agent){
    const route=agent.factory.management.options(agent.id,'foreground'),catalog=agent.factory.management.modelCapabilities().find(row=>row.provider===route.provider&&row.model===route.model);let modalities=validModalities(catalog?.inputModalities),authoritative=false,error;
    try{const prepared=await agent.ctx.llm.prepareCall({provider:route.provider,model:route.model,...(route.reasoningEffort?{reasoningEffort:route.reasoningEffort}:{})},AbortSignal.timeout(5000));modalities=validModalities(prepared.inputModalities);authoritative=true;}catch(e){error=/^[A-Z_]{3,80}$/u.test(e.code??e.message??'')?e.code??e.message:'MEDIA_MODEL_LOOKUP_FAILED';}
    return {provider:route.provider,model:route.model,inputModalities:modalities,imageInput:!modalities?.length?'unknown':modalities.includes('image')?'supported':'unsupported',authoritative,...(error?{error}:{})};
  }
  async assertRoute(agent){const route=await this.route(agent);assertImageModel(route.authoritative?route.inputModalities:null,1);return route;}
  async status(agent){return {version:1,images:{enabled:!!this.attachments,mimes:mediaPolicy.mimes,maxBytes:mediaPolicy.maxBytes,maxPerMessage:mediaPolicy.maxPerMessage,maxMessageBytes:mediaPolicy.maxMessageBytes,followup:'Explicit image follow-up requires reattachment in this version; no automatic historical-image replay.'},audio:{enabled:false,reason:'not-implemented'},video:{enabled:false,reason:'not-implemented'},route:await this.route(agent)};}
}
