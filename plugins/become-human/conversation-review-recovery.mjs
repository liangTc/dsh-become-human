import {createHash} from 'node:crypto';
import {modelFailureDiagnostic,saveModelFailure} from './model-failure.mjs';

const cooldownMs=5*60*1000;
const unavailableCodes=new Set(['MODEL_EXECUTION_FAILED','EMPTY_MODEL_OUTPUT','OUTPUT_LIMIT','REQUEST_TIMEOUT','NETWORK_ERROR','INVALID_CONVERSATION_REVIEW']);
const codeOf=error=>error?.code??error?.message;
const routeOf=agent=>agent.factory.management?.options(agent.id,'foreground')??agent.factory.config??{};
const routeKey=agent=>createHash('sha256').update(JSON.stringify(routeOf(agent))).digest('hex');
export function reviewAvailability(agent,now=Date.now()){
  const record=agent.factory.journal.value(agent.id,'conversationReviewCooldown',null);
  return record&&record.routeKey===routeKey(agent)&&record.until>now?{available:false,...record}:{available:true};
}
export function canDegradeReview(agent,signal,error,{epoch,blockingReviewRejected=false}={}){
  return !signal.aborted&&(epoch===undefined||agent.desired().epoch===epoch)&&!blockingReviewRejected&&unavailableCodes.has(codeOf(error));
}
export function recordReviewUnavailable(agent,error,{response,options,degraded,now=Date.now()}){
  const j=agent.factory.journal,id=agent.id,code=codeOf(error),route=routeOf(agent);
  const saved=j.value(id,'modelFailures',{}).foreground;
  const previous=saved&&error.attemptId&&saved.attemptId===error.attemptId?saved:null;
  const entry={...(previous??{at:now,attemptId:error.attemptId??null,lane:'foreground',purpose:'conversation-review',provider:route.provider,model:route.model,code:/^[A-Z_]{3,64}$/.test(code??'')?code:'MODEL_EXECUTION_FAILED',...modelFailureDiagnostic(error,code)}),disposition:degraded?'degraded':'held'};
  if(degraded)j.put(id,'conversationReviewCooldown',{routeKey:routeKey(agent),until:now+cooldownMs,code:entry.code,attemptId:entry.attemptId});
  saveModelFailure(j,id,entry);
  const quality={status:'review-unavailable',reason:'review-service-unavailable',causeAttemptId:entry.attemptId,code:entry.code,...(degraded?{retryAfter:now+cooldownMs}:{})};
  j.audit(id,'conversation-review-unavailable',{attemptId:response.rid,turn:options.turn,lane:'foreground',origin:'owner',...quality,status:degraded?'success':'failed',summary:degraded?'回复检查暂不可用，保留原回复继续基础校验。':'回复检查未完成，已有内容问题尚未确认解决，回复保留待处理。',disposition:entry.disposition,semanticVerified:false});
  return quality;
}
export function recordReviewSkipped(agent,response,options,availability){
  const quality={status:'review-unavailable',reason:'review-cooldown',causeAttemptId:availability.attemptId,code:availability.code,retryAfter:availability.until};
  agent.factory.journal.audit(agent.id,'conversation-review-skipped',{attemptId:response.rid,turn:options.turn,origin:'owner',lane:'foreground',...quality,status:'success',summary:'检查服务暂缓调用，本轮回复继续基础校验。',semanticVerified:false});
  return quality;
}
export function recordReviewRecovered(agent){
  const j=agent.factory.journal;if(j.value(agent.id,'conversationReviewCooldown',null))j.put(agent.id,'conversationReviewCooldown',null);
}
