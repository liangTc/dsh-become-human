// Human does not override per-call output, deadline or context-window settings.
// The host adapter resolves its configured defaults before autonomous admission.
export const modelCallOptions=config=>({provider:config.provider,model:config.model,...(config.reasoningEffort?{reasoningEffort:config.reasoningEffort}:{})});
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function modelOutputReservation(config={},context={}){
  return positive(config.maxTokens)?config.maxTokens:positive(context?.contextWindow)?context.contextWindow:null;
}
export function estimateModelCost(input,config={},context={}){
  return Buffer.byteLength(JSON.stringify(input),'utf8')+1024+(modelOutputReservation(config,context)??0);
}
export function autonomousBudgetEstimate(estimate,neededTokens){
  if(!Number.isSafeInteger(neededTokens)||neededTokens<=0)return estimate;
  return {...estimate,tokens:Math.max(estimate?.tokens??0,neededTokens),requests:estimate?.requests??1,basis:'includes-next-host-resolved-request'};
}
export function contextRetrievalSettings(value={}){
  return {memoryLimit:value.memoryLimit??8,historyLimit:value.historyLimit??8,learningLimit:value.learningLimit??3};
}
export function executionSettings(value={}){
  const {maxTokens,requestTimeoutMs,...current}=value;
  return {...current,context:contextRetrievalSettings(value.context)};
}
