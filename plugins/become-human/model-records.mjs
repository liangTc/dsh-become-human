// Read retained input/output on demand. Never store reasoning deltas or credentials.
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const privateKey=/^(?:api.?key|authorization|headers|cookie|set-cookie|token|access[_-]?token|password|secret|credential.*|reasoning.*|chain.?of.?thought|internal.?reasoning)$/i;
export function logSafe(value){
  if(typeof value==='string')return value.replace(/\bBearer\s+\S+/gi,'Bearer [已隐藏]').replace(/sk-[\w-]{16,}/g,'[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,'$1[已隐藏]').replace(/([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^\s&#]+/gi,'$1[已隐藏]').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[图片编码已省略]');
  if(Array.isArray(value))return value.map(logSafe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKey.test(key)).map(([key,v])=>[key,logSafe(v)]));
  return value;
}
export function modelRecord(journal,id,input){
  journal.assertAdmitted(id);
  if(typeof input.attemptId!=='string'||input.attemptId.length>128)throw Error('INVALID_REQUEST');
  const row=journal.db.prepare('SELECT id,request,response_text,state,error,started,ended FROM attempt WHERE agent=? AND id=?').get(id,input.attemptId);
  if(!row)throw Error('TASK_NOT_FOUND');
  const request=parse(row.request)??{};
  if(input.taskId&&request.taskId!==input.taskId)throw Error('TASK_NOT_FOUND');
  return {id:row.id,state:row.state,error:row.error,started:row.started,ended:row.ended,messages:logSafe(request.messages??[]),response:row.response_text===null?null:logSafe(row.response_text),responseRecorded:row.response_text!==null,request:input.export===true?logSafe(request):undefined};
}
