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
export function modelFailureDiagnostic(failure,localCode='MODEL_EXECUTION_FAILED'){
  const raw=plain(failure?.message),code=cleanCode(failure?.code),status=Number.isInteger(failure?.status)&&failure.status>=400&&failure.status<=599?failure.status:undefined;
  const text=(raw+' '+(code??'')).toLowerCase();let category='unknown',summary='模型调用未完成，现有证据不足以确认原因。',suggestion='先核对模型配置和服务商状态；需要时明确进行一次连接测试。';
  if(localCode==='EMPTY_MODEL_OUTPUT'){category='empty';summary='模型结束了请求，但没有返回可用正文。';suggestion='检查模型与接口协议是否兼容、服务商是否只返回了推理内容；这不是笔记证据检查失败。';}
  else if(localCode==='OUTPUT_LIMIT'){category='output-limit';summary='模型因输出长度限制而结束。';suggestion='核对服务商的输出限制和本次任务长度。';}
  else if(localCode==='INVALID_TASK_OUTPUT'){category='validation';summary='模型已返回内容，但结果未通过任务格式或证据校验。';suggestion='在任务日志查看具体校验原因；这与模型下线、余额不足或空正文是不同的问题。';}
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
  return {category,summary,suggestion,...status?{httpStatus:status}:{},...code?{upstreamCode:code}:{},upstreamMessage:safeProviderMessage(raw)};
}
export function saveModelFailure(journal,id,entry){
  const rows=journal.value(id,'modelFailures',{});journal.put(id,'modelFailures',{...rows,[entry.lane??'foreground']:entry});
}
export function clearModelFailure(journal,id,lane){const rows={...journal.value(id,'modelFailures',{})};if(rows[lane]){delete rows[lane];journal.put(id,'modelFailures',rows);}}
