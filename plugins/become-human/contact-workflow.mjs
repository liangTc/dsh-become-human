import {createHash} from 'node:crypto';
import {chatResult,careResult,outputDiagnostic} from './learning.mjs';
import {learningInvitationResult} from './learning-policy.mjs';
import {routeDisposition} from './learning-engagement.mjs';
import {socialStatus,socialDelay,assertSocialNovelty} from './social.mjs';
import {ownerSourceUsable} from './context.mjs';
const key=value=>createHash('sha256').update(value).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
export async function executeContact(ctx){
  const {agent,signal,turn,epoch,phase,valid,modelRequest,discoverSource,rejectInsufficientEvidence}=ctx;let task=ctx.task,response=ctx.response;const f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id,settings=store.settings(id);
  try{
      response=await ctx.executeModel(task);
      valid(agent,signal,epoch,task.persona_version);
      if(['share-insight','care','chat'].includes(task.kind)){
        const eligibleOwnerSourceIds=(response.ownerSourceIds??[]).filter(sourceId=>ownerSourceUsable(agent,sourceId));
        try{response.text=task.kind==='chat'?chatResult(response.text,eligibleOwnerSourceIds):task.kind==='care'?careResult(response.text,eligibleOwnerSourceIds):learningInvitationResult(response.text,{evidenceIds:store.note(id,task.checkpoint.noteId)?.data.claims?.flatMap(c=>c.evidenceIds??(c.evidenceId?[c.evidenceId]:[]))??[]});if(task.kind==='chat'&&response.text!=='[WAIT]')assertSocialNovelty(j,id,task.checkpoint.plan.question,response.text,Date.now(),settings.socialTopicCooldownMs,{unanswered:task.checkpoint.social?.unanswered??0,domain:f.domain});}catch(error){
          const diagnostic=outputDiagnostic(error,{phase:'execution',text:response.text});
          j.audit(id,'autonomy-output-rejected',{taskId:task.id,attemptId:response.rid,phase:'execution',code:error.message,responseHash:key(response.text),textChars:response.text.length,validationDiagnostic:diagnostic});
          j.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:error.message,textChars:response.text.length,reasoningChars:response.reasoningChars});
          if(['INVALID_TASK_OUTPUT','INVALID_PROACTIVE_OUTPUT','INVALID_CARE_OUTPUT','INVALID_CHAT_OUTPUT','REPEATED_SOCIAL_TOPIC','SOCIAL_REPLY_PRESSURE','SOCIAL_TASK_ROLE_MISMATCH','UNSUPPORTED_CARE_KNOWLEDGE','UNSUPPORTED_AGENT_EXPERIENCE','INTERNAL_EVIDENCE_REFERENCE'].includes(error.message)){
            // A rejected output never reaches the owner. Quarantine malformed
            // messages for the normal contact cooldown instead of disabling
            // every future autonomous event. Evidence and identity violations
            // still use the global error pause below; no immediate retry here.
            store.defer(id,task,error.message,socialDelay(settings,task));
            store.update(task.id,error.message==='UNSUPPORTED_CARE_KNOWLEDGE'?'cancelled':'failed',{...task.checkpoint,reason:error.message,failureDiagnostic:diagnostic});
            j.put(id,'autonomyWait',error.message);phase('waiting');response=null;return;
          }
          throw error;
        }
      }
        if(task.kind==='share-insight'&&response.text!=='[WAIT]'){
          const note=store.offerableNote(id,store.note(id,task.checkpoint.noteId)),now=Date.now(),lastOwner=agent.session.snapshotEvents().findLast(e=>e.type==='user/message')?.time??j.value(id,'autonomyActivatedAt',now),disposition=note?routeDisposition(j,f.domain,id,(note.data.researchQuestion??'')+' '+note.data.title,now):null;
          if(!note||disposition.cooldownUntil>now||store.quiet(settings,now)||settings.socialEnabled&&!socialStatus(j,f.domain,id,settings,now).canContact||now-Math.max(j.value(id,'lastAutonomousContact',0),lastOwner)<settings.contactCooldownMs){store.defer(id,task,'learning-invitation-deferred',settings.contactCooldownMs);store.update(task.id,'cancelled',{...task.checkpoint,reason:'learning-invitation-deferred'});response=null;phase('waiting');return;}
        }
        if(task.kind==='chat'&&response.text!=='[WAIT]'){
          const status=socialStatus(j,f.domain,id,settings);if(!status.ready){
            j.endAttempt(response.rid,{state:'wait',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',textChars:response.text.length,reasoningChars:response.reasoningChars});
            j.audit(id,'social-publication-deferred',{taskId:task.id,reason:status.reason});store.defer(id,task,status.reason,socialDelay(settings,task));store.update(task.id,'cancelled',{...task.checkpoint,reason:status.reason});response=null;phase('waiting');return;
          }
        }
        store.update(task.id,'completed',{...task.checkpoint,anchor:task.checkpoint.anchor,noteId:task.checkpoint.noteId});if(task.checkpoint.noteId&&response.text!=='[WAIT]'){const note=store.note(id,task.checkpoint.noteId);if(!note)throw failure('STALE_LEARNING_NOTE');response.noteId=note.id;}
      if(response.text==='[WAIT]'){store.defer(id,task,'executor-wait',socialDelay(settings,task));response=null;phase('waiting');return;}

  }finally{ctx.task=task;ctx.response=response;}
}
