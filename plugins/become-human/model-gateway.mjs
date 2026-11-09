import {strategyRequest} from './experience-strategy.mjs';
import {attachCurrentImages,estimateImageRequestCost,imageContentCount,assertImageModel} from './multimodal.mjs';
import {nativeDialogueMessages} from './dialogue-frame.mjs';
import {recordContext} from './context.mjs';
import {modelCallOptions,modelOutputReservation,estimateModelCost} from './model-policy.mjs';
const failure=code=>Object.assign(new Error(code),{code});
export function requestCost(input,config={},context){return estimateModelCost(input,config,context)+(Array.isArray(input)?estimateImageRequestCost(input):0);}

// All model work stays under the parent driver's single active interval and ticket gate.
export async function modelRequest(agent,signal,{turn,epoch,lane,messages,admittedIds=[],taskId,purpose}){
  const compacting=purpose==='conversation-summary';
  const reviewing=purpose==='conversation-review',styleRepair=purpose==='conversation-style-repair',learningReview=purpose==='learning-selection-review',internal=compacting||reviewing||styleRepair||learningReview;
  if(lane==='foreground'&&!internal)messages=attachCurrentImages(nativeDialogueMessages(messages),agent,{admittedIds,requireCapability:false});
  const f=agent.factory,j=f.journal,config=f.management?.options(agent.id,lane)??f.config,store=f.autonomy,budgetClass=lane==='foreground'?'foreground':'autonomous';
  signal.throwIfAborted();if(agent.desired().epoch!==epoch)throw failure('STALE_EPOCH');
  const strategyTask=lane==='executor'&&taskId?store.getTask(taskId):null;
  const strategyUses=strategyTask?f.experience?.strategies.forTask(agent.id,strategyTask)??[]:[];
  messages=strategyRequest(messages,strategyUses);
  recordContext(agent,messages,{taskId,turn,lane:compacting?'conversation-summary':reviewing?'conversation-review':styleRepair?'conversation-style-repair':learningReview?'learning-selection-review':lane});
  const ownerInputRevision=admittedIds.length?admittedIds.reduce((n,id)=>Math.max(n,j.db.prepare('SELECT rowid AS n FROM user_request WHERE agent=? AND message_id=?').get(agent.id,id)?.n??0),0):j.db.prepare('SELECT COALESCE(max(rowid),0) AS n FROM user_request WHERE agent=?').get(agent.id).n;
  let rid,amount,usage,finish,text='',reasoningChars=0,dispatched=false,settled=false;
  const requestSignal=signal;
  try{
    const prepared=await agent.ctx.llm.prepareCall(modelCallOptions(config),requestSignal);
    assertImageModel(prepared.inputModalities,imageContentCount(messages));
    requestSignal.throwIfAborted();if(agent.desired().epoch!==epoch)throw failure('STALE_EPOCH');
    const b=store.budget(agent.id),outputReservation=modelOutputReservation(prepared.config,prepared.context);
    if(budgetClass==='autonomous'&&b.tokenLimit!=null&&outputReservation===null)throw failure('MODEL_BUDGET_ESTIMATE_UNAVAILABLE');
    amount=requestCost(messages,prepared.config,prepared.context);
    rid=j.reserve(agent.id,amount,Infinity,{turn,epoch,request:{messages,context:messages.contextReport??null,...(purpose?{purpose}:{}),admittedIds,ownerInputRevision,pauseRevision:j.value(agent.id,'pauseRevision',0),taskId,roundId:lane==='foreground'?undefined:agent.activeRoundId??taskId,lane,budgetClass,budgetTime:b.now,modelLimitPolicy:'host-provider-defaults',outputReservation}});
    if(!rid){j.put(agent.id,'autonomyNeededTokens',amount);throw Object.assign(failure('AUTONOMOUS_BUDGET_EXHAUSTED'),{neededTokens:amount});}
    j.dispatchAttempt(rid,prepared.config);dispatched=true;await f.allowCall(requestSignal,{agent:agent.id,rid,epoch,config:prepared.config,messages});
    if(strategyUses.length)f.experience.strategies.delivered(agent.id,strategyTask,rid);
    j.audit(agent.id,'dispatch',{attemptId:rid,turn,epoch,lane,budgetClass,taskId,provider:prepared.config.provider,model:prepared.config.model,reserved:amount,admittedIds});
    for await(const chunk of prepared.stream({...prepared.config,messages,signal:requestSignal})){
      if(chunk.type==='text-delta')text+=chunk.text;
      if(chunk.type==='reasoning-delta')reasoningChars+=chunk.text.length;
      if(chunk.type==='usage'){const u=chunk.usage;usage=u&&['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].every(k=>k.endsWith('Tokens')&&u[k]===undefined&&k.startsWith('cache')||Number.isFinite(u[k])&&u[k]>=0)?u:undefined;}
      if(chunk.type==='finish')finish=chunk.reason;
    }
    signal.throwIfAborted();requestSignal.throwIfAborted();if(agent.desired().epoch!==epoch)throw failure('STALE_EPOCH');
    if(finish?.kind!=='stop'){const error=failure(['length','max-tokens'].includes(finish?.kind)?'OUTPUT_LIMIT':'MODEL_EXECUTION_FAILED');if(Number.isInteger(finish?.failure?.status)&&finish.failure.status>=400&&finish.failure.status<=599)error.status=finish.failure.status;throw error;}
    if(!text.trim())throw failure('EMPTY_MODEL_OUTPUT');
    const total=usage?usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0)+usage.outputTokens:undefined;
    j.settle(rid,total);settled=true;
    j.endAttempt(rid,{state:internal?'completed':lane==='foreground'?'generated':lane==='selection'?'selected':'executed',usage,usageConfidence:usage?'reported':'unknown',textChars:text.length,reasoningChars});
    j.put(agent.id,'lastUsage',usage??null);j.put(agent.id,'lastUsageConfidence',usage?'reported':'unknown');
    return {rid,text:text.trim(),usage,reasoningChars,provider:prepared.config.provider,model:prepared.config.model,workMemoryRefs:messages.contextReport?.workMemoryRefs??[]};
  }catch(error){
    const code=signal.aborted?'USER_PREEMPTED':requestSignal.aborted?'REQUEST_TIMEOUT':error.code??error.message;
    if(rid&&!settled){if(dispatched)j.settle(rid);else j.release(rid);}
    const failureFacts={phase:dispatched?'stream':'prepare',...(finish?{streamFinish:['stop','length','max-tokens','error','aborted'].includes(finish.kind)?finish.kind:'other'}:{}),exceptionType:['TypeError','RangeError','SyntaxError','Error'].includes(error.name)?error.name:'ProviderError',missingAssistantSource:messages.filter(message=>message.role==='assistant'&&!message.source).length,...(Number.isInteger(error.status)&&error.status>=400&&error.status<=599?{httpStatus:error.status}:{})};
    if(rid)j.endAttempt(rid,{state:signal.aborted?'cancelled':'failed',usage,usageConfidence:dispatched?'unknown':'not-dispatched',error:/^[A-Z_]{3,64}$/.test(code)?code:'MODEL_EXECUTION_FAILED',textChars:text.length,reasoningChars,failureFacts});
    else j.audit(agent.id,'model-preparation-rejected',{lane,taskId,code:/^[A-Z_]{3,64}$/.test(code)?code:'MODEL_EXECUTION_FAILED',failureFacts});
    throw Object.assign(failure(/^[A-Z_]{3,64}$/.test(code)?code:'MODEL_EXECUTION_FAILED'),code==='AUTONOMOUS_BUDGET_EXHAUSTED'&&Number.isSafeInteger(error.neededTokens)?{neededTokens:error.neededTokens}:{});
  }finally{f.tickets.delete(requestSignal);}
}
