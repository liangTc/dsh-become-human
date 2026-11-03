import {fetchResearch,sourceFailureDiagnostic} from './learning.mjs';
import {developmentInput} from './knowledge-signals.mjs';
import {cachedLearningDraft} from './learning-selection-review.mjs';
// Deep research is one behavior workflow. Its strict source contracts do not
// define the contracts for conversation, capability use or digital experience.
import {createHash} from 'node:crypto';
import {learningResult,outputDiagnostic} from './learning.mjs';
import {reviewLearningSelection} from './learning-selection-review.mjs';
const key=value=>createHash('sha256').update(value).digest('hex');
function rejectedLearningField(text,diagnostic){
  // Keep only the bounded field that failed validation, as untrusted diagnostic
  // data. Never promote it to a note, memory, context fact or published reply.
  const field=diagnostic?.field;if(typeof field!=='string')return null;
  let value;try{const parsed=JSON.parse(text);if(['title','summary','relevance','question','share'].includes(field))value=parsed[field];else if(field==='claims.text'){const index=diagnostic.claimIndex;if(Number.isSafeInteger(index)&&index>=0&&index<32)value=parsed.claims?.[index]?.text;else if(parsed.claims?.length===1)value=parsed.claims[0]?.text;else if(Array.isArray(parsed.claims))value=JSON.stringify(parsed.claims.slice(0,4).map((claim,index)=>({index,text:typeof claim.text==='string'?claim.text.slice(0,400):null})));}else{const match=/^claims\[(\d{1,2})\]\.text$/u.exec(field);if(match)value=parsed.claims?.[Number(match[1])]?.text;}}catch{return null;}
  if(typeof value!=='string')return null;
  if(/(?:sk-[\w-]{16,}|Bearer\s+\S+|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S+)/iu.test(value))return {field,hash:key(value),redacted:true,unverified:true};
  return {field,text:value.slice(0,800),hash:key(value),truncated:value.length>800,unverified:true,purpose:'output-validation-diagnostic-only'};
}

async function finishDeepLearning(agent,task,response,signal,{turn,epoch,modelRequest,valid,phase,rejectInsufficientEvidence}){
  const f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id,settings=store.settings(id);
        let result;
        try{result=learningResult(response.text,task.checkpoint.source,{strictSelection:f.learningSelectionReview===true});}catch(error){
          const diagnostic=outputDiagnostic(error,{phase:'learning',text:response.text,source:task.checkpoint.source});
          j.audit(id,'learning-rejected',{taskId:task.id,attemptId:response.rid,code:error.message,responseHash:key(response.text),textChars:response.text.length,validationDiagnostic:diagnostic});
          j.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:error.message,textChars:response.text.length,reasoningChars:response.reasoningChars});
          if(['INVALID_TASK_OUTPUT','INVALID_LEARNING_CLAIM_COUNT','INVALID_LEARNING_CLAIM_TEXT','UNSUPPORTED_LEARNING_EVIDENCE','UNSUPPORTED_LEARNING_CLAIM','UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE','LEARNING_EVIDENCE_SELECTION_TOO_LONG','INVALID_LEARNING_SOURCE_SELECTION'].includes(error.message)){
            // Malformed model output is local to this task. Keep rejecting it,
            // preserve accounting, and cool down the same source without
            // declaring the source itself insufficient or pausing other work.
            store.defer(id,task,error.message,settings.sourceIntervalMs);
            store.update(task.id,'failed',{...task.checkpoint,reason:error.message,failureCategory:'output-validation',failureDiagnostic:diagnostic,rejectedOutputField:rejectedLearningField(response.text,diagnostic)});
            j.put(id,'autonomyWait',error.message);phase('waiting');response=null;return;
          }
          throw error;
        }
        if(result.evidenceStatus==='insufficient'){rejectInsufficientEvidence(agent,task,response,'declared-insufficient');response=null;return;}
        if(f.learningSelectionReview){
          phase('reviewing-learning');let reviewed;
          try{reviewed=await reviewLearningSelection(agent,signal,{task,response,result,request:modelRequest,turn,epoch});}
          catch(error){if(error.message!=='INVALID_LEARNING_SELECTION_REVIEW')throw error;const current=store.getTask(task.id);store.defer(id,current,error.message,settings.sourceIntervalMs);store.update(task.id,'failed',{...current.checkpoint,reason:error.message,failureCategory:'output-validation'});j.put(id,'autonomyWait',error.message);phase('waiting');response=null;return;}
          valid(agent,signal,epoch,task.persona_version);
          if(reviewed.decision!=='accept'){rejectInsufficientEvidence(agent,task,response,'selected-content-outside-question-scope');response=null;return;}
          result.selectionReview=reviewed.metadata;
        }
        {const {learningDraft,...checkpoint}=task.checkpoint;task={...task,checkpoint};}
        const noteId=store.commitNote(id,task,task.checkpoint.source,result);
        f.goals?.reconcile(id);if(settings.goalProposalsEnabled)try{f.goals?.proposeFromNote(id,noteId,{enabled:true});}catch(error){j.audit(id,'goal-proposal-skipped',{taskId:task.id,code:/^[A-Z_]+$/.test(error.message)?error.message:'GOAL_PROPOSAL_FAILED'});}
        j.audit(id,'learning-committed',{taskId:task.id,noteId,sourceDigest:task.checkpoint.source.digest});
        // Learning never publishes its internal summary. A separate invitation
        // turn must pass relevance, interest, contact and short-output gates.
        j.audit(id,'learning-kept-private',{taskId:task.id,noteId,reason:'invitation-and-owner-follow-up-required'});
        response=null;phase('learned-without-notification');return;

}

export function learningOpportunitySnapshot(agent,{settings,now}){
  const store=agent.factory.autonomy,j=agent.factory.journal,id=agent.id;
  const sources=[...new Map([...(settings.searchEnabled?store.correctionSources(id):[]),...settings.sources].filter(s=>!developmentInput(s.title)&&!developmentInput(s.topic)).map(s=>[s.url,s])).values()];
  return {settings,now,lastResearchAt:j.value(id,'lastResearchAt',0),sources:sources.map(spec=>({spec,checkedAt:j.value(id,'source-check:'+key(spec.url),0),correction:store.correction(id,spec.url),declined:!!store.notes(id).find(n=>(n.data.source.requestedUrl??n.data.source.url)===spec.url&&n.feedback?.value==='not-now'&&now-n.feedback.time<settings.sourceIntervalMs)}))};
}

// Scoped execution facade: the pack receives no database, factory, credentials,
// arbitrary session selector or separate model entry. Each effect is rechecked.
export function learningExecutionContext(ctx,guard){
  const {agent,signal,epoch}=ctx,f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id;
  const settings=()=>store.settings(id);
  const valid=()=>guard();
  return Object.freeze({
    get task(){return structuredClone(ctx.task);},get response(){return ctx.response;},set response(value){ctx.response=value;},signal,valid,
    phase:ctx.phase,
    markSourceChecked:url=>{valid();j.put(id,'source-check:'+key(url),Date.now());},
    fetchSource:async spec=>{valid();const result=await fetchResearch(spec,signal);valid();return result;},
    alreadyLearned:source=>j.value(id,'learned:'+key(source.url),null)===source.digest,
    cancelUnchanged:()=>{valid();store.defer(id,ctx.task,'SOURCE_ALREADY_LEARNED',settings().sourceIntervalMs);store.update(ctx.task.id,'cancelled',{...ctx.task.checkpoint,reason:'SOURCE_ALREADY_LEARNED'});ctx.phase('waiting');},
    saveSource:source=>{valid();store.update(ctx.task.id,'ready',{...ctx.task.checkpoint,source});ctx.task=store.getTask(ctx.task.id);},
    failSource:error=>{valid();const code=/^[A-Z_]{3,80}$/.test(error.message)?error.message:'SOURCE_FETCH_FAILED';store.defer(id,ctx.task,code,settings().sourceIntervalMs);store.update(ctx.task.id,'failed',{...ctx.task.checkpoint,reason:code});j.audit(id,'selected-source-failed',{taskId:ctx.task.id,code,sourceDiagnostic:sourceFailureDiagnostic(error)});ctx.phase('waiting');},
    discover:async()=>{valid();const task=await ctx.discoverSource(agent,signal,ctx.task,settings(),epoch);valid();if(task)ctx.task=task;return !!task;},
    cachedDraft:()=>{valid();return f.learningSelectionReview&&ctx.task.checkpoint.source?cachedLearningDraft(ctx.task):null;},
    executeModel:async()=>{valid();const response=await ctx.executeModel(ctx.task);ctx.response=response;valid();return response;},
    rejectInsufficient:reason=>{valid();ctx.rejectInsufficientEvidence(agent,ctx.task,ctx.response,reason);},
    commitValidated:async()=>{valid();await finishDeepLearning(agent,ctx.task,ctx.response,signal,{...ctx,valid});valid();}
  });
}
