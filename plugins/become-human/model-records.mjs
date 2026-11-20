// Read retained input/output on demand. Never store reasoning deltas or credentials.
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const privateKey=/^(?:api.?key|authorization|headers|cookie|set-cookie|token|access[_-]?token|password|secret|credential.*|reasoning.*|chain.?of.?thought|internal.?reasoning)$/i;
const streamCountKeys=['text','reasoning','usage','finish','other'];
export const validStreamCount=value=>Number.isSafeInteger(value)&&value>=0;
export function safeStreamCounts(value){
  return Object.fromEntries(streamCountKeys.filter(key=>validStreamCount(value?.[key])).map(key=>[key,value[key]]));
}
function streamFactsForExport(facts){
  const result={};
  for(const key of ['textChars','reasoningChars','textDeltaChars','finalTextChars']){
    if(validStreamCount(facts[key]))result[key]=facts[key];
  }
  if(facts.streamCounts)result.streamCounts=safeStreamCounts(facts.streamCounts);
  if(['stop','length','max-tokens','error','aborted','other'].includes(facts.streamFinish))result.streamFinish=facts.streamFinish;
  return result;
}
export function logSafe(value){
  if(typeof value==='string')return value.replace(/\bBearer\s+\S+/gi,'Bearer [已隐藏]').replace(/sk-[\w-]{16,}/g,'[已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,'$1[已隐藏]').replace(/([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^\s&#]+/gi,'$1[已隐藏]').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[图片编码已省略]');
  if(Array.isArray(value))return value.map(logSafe);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key,v])=>key==='reasoningChars'?validStreamCount(v):!privateKey.test(key))
    .map(([key,v])=>[key,key==='streamCounts'?safeStreamCounts(v):logSafe(v)]));
  return value;
}
export function modelRecord(journal,id,input){
  journal.assertAdmitted(id);
  if(typeof input.attemptId!=='string'||input.attemptId.length>128)throw Error('INVALID_REQUEST');
  const exporting=input.export===true;
  const columns='id,request,response_text,state,error,started,ended'+(exporting?',failure_facts':'');
  const row=journal.db.prepare('SELECT '+columns+' FROM attempt WHERE agent=? AND id=?').get(id,input.attemptId);
  if(!row)throw Error('TASK_NOT_FOUND');
  const request=parse(row.request)??{};
  if(input.taskId&&request.taskId!==input.taskId)throw Error('TASK_NOT_FOUND');
  const storedFacts=exporting&&parse(row.failure_facts);
  return {id:row.id,state:row.state,error:row.error,started:row.started,ended:row.ended,messages:logSafe(request.messages??[]),response:row.response_text===null?null:logSafe(row.response_text),responseRecorded:row.response_text!==null,request:exporting?logSafe(request):undefined,...(storedFacts?{failureFacts:streamFactsForExport(storedFacts)}:{})};
}
