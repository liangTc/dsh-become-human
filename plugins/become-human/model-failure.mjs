const knownCodes=new Set(['UNKNOWN','MODEL_NOT_FOUND','INVALID_MODEL','MODEL_DEPRECATED','MODEL_DISABLED','INVALID_CREDENTIAL','MISSING_CREDENTIAL','UNAUTHORIZED','FORBIDDEN','QUOTA_EXCEEDED','ACCOUNT_QUOTA_EXCEEDED','RATE_LIMITED','RATE_LIMIT_EXCEEDED','CONTEXT_WINDOW_EXCEEDED','EMPTY_RESPONSE','TIMEOUT','NETWORK_ERROR','ABORTED']);
const plain=value=>typeof value==='string'?value:'';
const cleanCode=value=>knownCodes.has(value)?value:undefined;
export function safeProviderMessage(value){
  let text=plain(value).slice(0,4096);
  // Some SDKs wrap a provider error in JSON. Never retain echoed requests.
  try{const body=JSON.parse(text);text=plain(body?.error?.message)||plain(body?.message);}catch{}
  text=text.replace(/-----BEGIN[\s\S]*$/g,'[已隐藏证书内容]')
    .replace(/\b(?:sk|rk|pk|sess)[-_][A-Za-z0-9_-]{8,}/gi,'[已隐藏凭据]')
    .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [已隐藏凭据]')
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|cookie|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[已隐藏凭据]')
    .replace(/https?:\/\/[^\s<>"']+/gi,'[服务地址已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\n\r"']+/g,'[本地路径已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[长标识已隐藏]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi,'[邮箱已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  // A response containing a request dump is not an appropriate diagnostic.
  if(/(?:["']?(?:messages|prompt|input|requestBody|request_body|headers)["']?\s*[:=]|<html|<!doctype)/i.test(text))return '上游附带了请求或页面内容，已隐藏；请根据错误分类和状态码排查。';
  return text.slice(0,600);
}
const transientCategories=new Set(['empty','timeout','network','incomplete-stream','rate-limit','provider-unavailable']);
export function transientModelFailure(entry){
  if(!entry)return false;
  if(entry.httpStatus>=400)return entry.httpStatus===408||entry.httpStatus===429||entry.httpStatus>=500&&entry.httpStatus<=599;
  if(entry.category&&entry.category!=='unknown')return transientCategories.has(entry.category);
  return ['EMPTY_MODEL_OUTPUT','REQUEST_TIMEOUT','NETWORK_ERROR'].includes(entry.code);
}
export function modelFailureDiagnostic(failure,localCode='MODEL_EXECUTION_FAILED',streamFacts={}){
  const raw=plain(failure?.message),code=cleanCode(failure?.code),status=Number.isInteger(failure?.status)&&failure.status>=400&&failure.status<=599?failure.status:undefined;
  const text=(raw+' '+(code??'')).toLowerCase();let category='unknown',summary='模型调用未完成，现有证据不足以确认原因。',suggestion='先核对模型配置和服务商状态；需要时明确进行一次连接测试。';
  if(localCode==='EMPTY_MODEL_OUTPUT'||code==='EMPTY_RESPONSE'){
    category='empty';
    if(streamFacts.textChars>0)summary='Human 收到的模型正文只含空白字符。';
    else if(streamFacts.reasoningChars>0)summary='Human 收到了推理内容，未读到可用正文。';
    else summary='模型响应已结束，Human 未读到可用正文。';
    suggestion='可在日志中核对本次流式返回记录。';
  }
  else if(localCode==='OUTPUT_LIMIT'){category='output-limit';summary='模型因输出长度限制而结束。';suggestion='核对服务商的输出限制和本次任务长度。';}
  else if(localCode==='INVALID_TASK_OUTPUT'){category='validation';summary='模型已返回内容，但结果未通过任务格式或证据校验。';suggestion='在任务日志查看具体校验原因；这与模型下线、余额不足或空正文是不同的问题。';}
  else if(localCode==='INVALID_CONVERSATION_REVIEW'){category='review-protocol';summary='回复检查返回了无法解析的检查结果，没有取得有效结论。';suggestion='检查调用的原始返回与接口兼容性；无法解析不等于回复内容不合格。';}
  else if(/stream ended without finish_reason|stream.{0,40}(?:premature|incomplete)|unexpected end of (?:stream|sse)/.test(text)){category='incomplete-stream';summary='模型响应流未完整结束，未收到有效的完成标记。';suggestion='供应商有生成记录不代表客户端已收到完整结果。请核对代理或兼容接口是否完整转发流式正文和 finish_reason；本地无法据此确认是供应商、代理还是传输中断。';}
  else if(/(?:model.{0,80}(?:retired|deprecated|decommissioned|discontinued|no longer available)|模型.{0,30}(?:下线|停用|废弃))/.test(text)){category='model-retired';summary='上游报告模型已停用或下线。';suggestion='在模型设置重新读取可用模型，并选择仍受支持的型号。';}
  else if(/model_not_found|invalid_model|model_disabled|(?:model.{0,80}(?:not found|does not exist|not exist|unavailable|not available|not supported|disabled))|模型.{0,30}(?:不存在|不可用|不支持)/.test(text)){category='model-unavailable';summary='上游报告模型不存在、不可用或当前账户无权访问。';suggestion='核对模型名称、可用模型列表及账户权限；不能仅据此认定模型过期。';}
  else if(status===401||/invalid_credential|missing_credential|unauthorized|invalid api.?key|(?:token|credential).{0,20}expired/.test(text)){category='authentication';summary='模型凭据无效、缺失或已过期。';suggestion='在 DSH 中更新该服务商的凭据，再核对 Human 的模型选择。';}
  else if(status===402||/insufficient.{0,20}(?:balance|credit|quota)|account_quota|余额不足|欠费/.test(text)){category='provider-quota';summary='上游账户余额或套餐额度不足。';suggestion='核对服务商账户余额或套餐；提高 Human 本地额度不能解除服务商限制。';}
  else if(status===429||/rate.?limit|quota_exceeded|限流/.test(text)){category='rate-limit';summary='上游限制了本次请求频率或额度。';suggestion='检查套餐限制并等待服务商恢复；不要连续重复提交。';}
  else if(status===403){category='permission';summary='服务商拒绝了当前账户的访问权限。';suggestion='核对账户、模型权限和服务商访问策略。';}
  else if(status===404){category='not-found';summary='上游请求的接口或模型未找到。';suggestion='核对接口地址和模型名；404 本身不能证明模型已经过期。';}
  else if(/context_window|context length|maximum context|上下文.{0,10}(?:超|长)/.test(text)){category='context';summary='本次输入超出了上游模型的上下文容量。';suggestion='核对实际模型容量及对话压缩状态。';}
  else if(status>=500){category='provider-unavailable';summary='上游服务暂时无法完成请求。';suggestion='检查服务商状态，恢复后再明确重试。';}
  else if(localCode==='REQUEST_TIMEOUT'||/timeout|timed out|超时/.test(text)){category='timeout';summary='等待模型响应超时。';suggestion='检查网络、代理和服务商状态。';}
  else if(/fetch failed|network|econn|enotfound|socket|certificate/.test(text)){category='network';summary='连接模型服务时发生网络错误。';suggestion='检查网络、DNS、代理和证书配置。';}
  return {category,summary,suggestion,...status?{httpStatus:status}:{},...code?{upstreamCode:code}:{},upstreamMessage:raw.trim()===localCode?'':safeProviderMessage(raw)};
}
export function modelFailureStage(entry){
  return ({'conversation-review':'回复检查','conversation-summary':'对话摘要','conversation-style-repair':'回复调整','learning-selection-review':'学习选题检查'})[entry.purpose]
    ??({foreground:'对话生成',selection:'自主选题',executor:'自主执行',development:'记忆与人格整理'})[entry.lane]??'模型调用';
}
// Old persisted alerts can be explained using their saved evidence without
// rewriting the historical attempt or manufacturing a new failure event.
export function explainModelFailure(entry){
  const diagnostic=modelFailureDiagnostic({message:entry.upstreamMessage,status:entry.httpStatus,code:entry.upstreamCode},entry.code,entry);
  const result={...entry,...(!entry.category||entry.category==='unknown'||entry.category==='empty'?diagnostic:{})};
  if(entry.purpose==='conversation-review')result.summary=(entry.disposition==='degraded'?'回复检查暂不可用，本轮改用基础校验继续处理已生成回复。':'回复检查未完成，已生成的回复尚未投递。')+result.summary;
  return result;
}
const nonFailures=new Set(['USER_PREEMPTED','USER_STOPPED','ABORTED','STALE_EPOCH','STALE_RESPONSE','AUTONOMOUS_BUDGET_EXHAUSTED']);
export function modelFailureNotification(entry){
  const detail=explainModelFailure(entry),safe=value=>safeProviderMessage(value).slice(0,180);
  const code=/^[A-Z_]{3,64}$/.test(entry.code??'')?entry.code:'MODEL_EXECUTION_FAILED';
  const at=new Date(entry.at);
  return ['模型调用异常 · '+modelFailureStage(entry),safeProviderMessage(detail.summary),
    '模型：'+(safe(entry.provider)||'未记录服务商')+' / '+(safe(entry.model)||'未记录模型'),
    '错误：'+code+(detail.httpStatus?' · HTTP '+detail.httpStatus:''),
    ...(detail.upstreamMessage?['说明：'+safeProviderMessage(detail.upstreamMessage)]:[]),
    safeProviderMessage(detail.suggestion),
    ...(Number.isFinite(at.getTime())?['时间：'+at.toISOString()]:[]),
    '会话与记忆已保留。可在 Web 的日志中查看本次调用。'].filter(Boolean).join('\n');
}
export function saveModelFailure(journal,id,entry,{notify=true}={}){
  if(nonFailures.has(entry.code))return;
  const save=()=>{
    const rows=journal.value(id,'modelFailures',{}),lane=entry.lane??'foreground',previous=rows[lane];
    const sameIncident=lane!=='foreground'&&transientModelFailure(entry)&&previous&&
      ['purpose','provider','model','code','category'].every(key=>previous[key]===entry[key]);
    const lastNotice=sameIncident?previous.noticeAt:undefined;
    const recent=Number.isFinite(lastNotice)&&entry.at>=lastNotice&&entry.at-lastNotice<60*60*1000;
    const send=notify&&!recent;
    const noticeAt=send?entry.at:lastNotice;
    journal.put(id,'modelFailures',{...rows,[lane]:{...entry,...(Number.isFinite(noticeAt)?{noticeAt}:{})}});
    if(!send)return;
    // An attempt is a stable identity across polling and restarts. Preparation
    // failures have no attempt yet, so use the failure occurrence's identity.
    const identity=entry.attemptId??'prepare:'+JSON.stringify([entry.at,entry.lane,entry.purpose,entry.code]);
    journal.publish?.(id,modelFailureNotification(entry),'model-error','model-error:'+identity,entry.at);
  };
  if(journal.transaction)journal.transaction(save);else save();
}
export function clearModelFailure(journal,id,lane){const rows={...journal.value(id,'modelFailures',{})};if(rows[lane]){delete rows[lane];journal.put(id,'modelFailures',rows);}}
