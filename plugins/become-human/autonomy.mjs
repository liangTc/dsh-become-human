import {modelRequest,requestCost} from './model-gateway.mjs';
import {selectionMessages,learningSemanticPolicy} from './task-prompts.mjs';
import {DshTaskExecutor} from './task-executor.mjs';
import {discoverPublicSource} from './research-discovery.mjs';
export {modelRequest,requestCost,DshTaskExecutor,learningSemanticPolicy};
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {selectedTaskWorkflow} from './autonomy-workflows.mjs';
import {drainActivityFeedback} from './activity-feedback.mjs';
import {candidate,selectionMemoryKey} from './autonomy-opportunities.mjs';
export {candidate} from './autonomy-opportunities.mjs';
import {checkpointForOpportunity,resolveBehaviorChoice} from './behavior-selection.mjs';
import {matterAllowed,linkMatterTask,bindMatterTask,reconcileCognition} from './cognition-runtime.mjs';
import {capabilityDialogue,isSourceGroundedReply} from './capability-dialogue.mjs';
import {choiceDialogueRequest} from './choice-dialogue.mjs';
import {recentDialogue} from './dialogue-history.mjs';
import {compactConversation} from './dialogue-compaction.mjs';
import {cachedLearningDraft,learningSelectionPolicy} from './learning-selection-review.mjs';
import {createAssistantMessage} from './api.mjs';
import {conversationPolicy as baseConversationPolicy,experienceGroundingPolicy,foregroundConversationPolicy,conversationalText,conversationOptions} from './conversation.mjs';
import {learningOrigin,validateLearningIntent} from './learning-policy.mjs';
import {learningEngagementSnapshot,studyDisposition,explicitLearningNoteRequest,delegateLearningLookup} from './learning-engagement.mjs';
import {structured,claimTextProjection,assertAgentPerspective,assertAgentExperience,outputDiagnostic,requireOutputText} from './learning.mjs';
import {searchQuery} from './research.mjs';
import {expressionPrompt} from './expression.mjs';
import {autonomousBudgetEstimate} from './model-policy.mjs';
import {quotaAllows,roundDuration} from './quota.mjs';
import {contextMessages} from './context.mjs';
import {socialStatus,socialDelay,assertSocialNovelty} from './social.mjs';
import {ownerCommand,pendingOwnerCommand} from './owner-commands.mjs';
import {nextActionWork} from './action-loop.mjs';
import {ownerTurnPlan,beginOwnerBatch,bindOwnerResponse,restoreOwnerBatch,finishOwnerBatch} from './owner-turns.mjs';
const conversationPolicy=baseConversationPolicy+experienceGroundingPolicy;
const key=value=>createHash('sha256').update(value).digest('hex');

const failure=(code)=>Object.assign(new Error(code),{code});
const contractFailure=(field,reason,extra={})=>Object.assign(failure('INVALID_TASK_OUTPUT'),{validationDiagnostic:{field,reason,...extra}});

function foregroundSystem(agent,admitted){
  const skill=agent.factory.management?.skills.prompt(agent.id,'foreground',admitted.map(m=>m.content.filter(c=>c.type==='text').map(c=>c.text).join('')).join(' '))??expressionPrompt('foreground');
  return conversationPolicy+foregroundConversationPolicy+skill;
}
function recentMessages(agent,options={}){return recentDialogue(agent,options);}
function valid(agent,signal,epoch,personaVersion){signal.throwIfAborted();if(agent.activeCognitionTask)agent.factory.experience?.strategies.forTask(agent.id,agent.activeCognitionTask);if(agent.activeCognitionTask?.checkpoint.pluginEventIds?.length&&!agent.factory.pluginEvents?.valid(agent.id,agent.activeCognitionTask.checkpoint.pluginEventIds))throw failure('PLUGIN_EVENT_UNAVAILABLE');if(agent.activeCognitionTask&&!matterAllowed(agent,agent.activeCognitionTask))throw failure('MATTER_NO_LONGER_ACTIVE');if(agent.activeGoalTask&&agent.factory.autonomy.getTask(agent.activeGoalTask.id)?.status!=='completed'&&!agent.factory.goals?.taskAllowed(agent.id,agent.activeGoalTask))throw failure('GOAL_NO_LONGER_ACTIVE');agent.factory.journal.assertAdmitted(agent.id);if(agent.desired().desired!=='running'||agent.desired().epoch!==epoch)throw failure('STALE_RESULT');if(personaVersion!==undefined&&agent.factory.domain.persona(agent.id).version!==personaVersion)throw failure('STALE_PERSONA');}

// A bounded DSH model executor, using ephemeral task data rather than another durable Session.
export function estimateTaskBudget(agent,task){
  if(task.kind==='behavior'&&task.checkpoint.plan)return {tokens:0,requests:0,selection:0,executor:0,review:0}; // Any optional model call reserves at dispatch.
  const store=agent.factory.autonomy,config=agent.factory.management?.options(agent.id,'executor')??agent.factory.config,planned=!!task.checkpoint.plan;
  if(task.kind==='behavior-choice'){const selection=requestCost(selectionMessages(agent,task,store.persona(agent.id,'selection')),agent.factory.management?.options(agent.id,'selection')??config);return {tokens:selection,requests:1,selection,executor:0,review:0};} // Execution is unknown until chosen; each later call reserves separately.
  // Preliminary material estimate only; every actual call reserves again using
  // the host adapter's resolved output/default or context capacity.
  const executor=planned&&(task.kind!=='research'||task.checkpoint.source)?requestCost(new DshTaskExecutor().input(agent,{task,source:task.checkpoint.source,persona:store.persona(agent.id,'execution')}),config):requestCost({candidate:task.checkpoint.candidate??null,source:task.checkpoint.source??null},config);
  const selection=planned?0:requestCost(selectionMessages(agent,task,store.persona(agent.id,'selection')),agent.factory.management?.options(agent.id,'selection')??config);
  const reviewing=agent.factory.learningSelectionReview===true&&['research','learn-ai'].includes(task.kind),hasDraft=reviewing&&!!task.checkpoint.source&&!!cachedLearningDraft(task),review=reviewing?requestCost({policy:learningSelectionPolicy,question:task.checkpoint.plan?.question??task.checkpoint.candidate?.question,source:task.checkpoint.source??null,selectedText:' '.repeat(3200)},config):0;
  return {tokens:selection+(hasDraft?0:executor)+review,requests:(planned?1:2)+(reviewing?1:0)-(hasDraft?1:0),selection,executor:hasDraft?0:executor,review};
}


export function discoverSource(agent,signal,task,settings,epoch,options={}){return discoverPublicSource(agent,signal,task,settings,epoch,{...options,valid});}

function rejectInsufficientEvidence(agent,task,response,reason){
  const {journal:j,autonomy:store}=agent.factory,id=agent.id,cp={...task.checkpoint},source=cp.source;
  delete cp.learningDraft;
  j.endAttempt(response.rid,{state:'evidence-insufficient',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',textChars:response.text.length,reasoningChars:response.reasoningChars});
  j.audit(id,'learning-evidence-insufficient',{taskId:task.id,attemptId:response.rid,sourceDigest:source.digest,code:reason});
  if(task.kind==='research'&&cp.discovery&&(cp.researchReads??0)<cp.discovery.results.length){
    cp.rejectedSources=[...(cp.rejectedSources??[]),{url:source.url,digest:source.digest,reason}].slice(-6);cp.source=null;store.update(task.id,'suspended',cp);
  }else{store.defer(id,task,'INSUFFICIENT_SOURCE_EVIDENCE',store.settings(id).sourceIntervalMs);store.update(task.id,'failed',{...cp,reason:'INSUFFICIENT_SOURCE_EVIDENCE',failureCategory:'source-insufficient'});}
  j.put(id,'autonomyWait','insufficient-source-evidence');j.put(id,'autonomyPhase','waiting');
}

export async function runAutonomyTurn(agent,signal){
  const f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id,epoch=agent.desired().epoch,settings=store.settings(id);
  const parentSignal=signal;let roundSignal,segment,segmentStartedMono;
  const remaining=j.value(id,'remaining',0);if(remaining!==null&&remaining<=0){j.set(id,'paused');return;}
  const turn=(agent.ctx.sessionProjections.stateOf(agent.session,'turnBoundary')?.lastTurn??0)+1;
  let task,response,stageId,entered=false,reason={kind:'completed'},admitted=[],ownerBatch,lane='autonomous';
  const phase=value=>j.put(id,'autonomyPhase',value);
  agent.session.append('turn/start',{turn});agent.session.append('step/start',{turn,step:1});entered=true;
  try{
    const plan=ownerTurnPlan(agent),target=plan?.target??'next-turn',pending=plan?.messages??[];
    const recoveredCommand=pending.length?null:pendingOwnerCommand(agent);
    if(pending.length||recoveredCommand){
      lane='foreground';agent.activeLane='foreground';phase('dialogue');ownerBatch=recoveredCommand?null:beginOwnerBatch(agent,plan,turn);admitted=recoveredCommand?[recoveredCommand.message]:agent.inbox.splice(target,0,pending.length,[]);
      for(const m of admitted){if(!agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===m.id))agent.session.append('user/message',m,{surfaceOp:'append'});agent.events.emit('agent/inbox/claimed',{message:m,turn});f.domain.observe(id,m);}
      await agent.flush();valid(agent,signal,epoch);
      const persona=store.persona(id,'dialogue');
      const engagement=learningEngagementSnapshot(j,f.domain,id),followUp=engagement.offers.findLast(offer=>admitted.some(m=>m.id===offer.interestedSourceId));
      const noteProbe=explicitLearningNoteRequest(admitted,[]),requestedNote=noteProbe.requested?explicitLearningNoteRequest(admitted,(f.actions?.eligibleNotes(id,{limit:100})?.items??[]).filter(n=>n.eligible===true).map(n=>store.note(id,n.id)).filter(Boolean)):noteProbe;
      const followUpNote=['explicit-url-needs-current-read','owner-changed-topic','owner-stopped-note-request'].includes(requestedNote.reason)?null:requestedNote.requested?(requestedNote.noteId?store.note(id,requestedNote.noteId):null):followUp?store.note(id,followUp.noteId):null,noteOwnerSourceId=requestedNote.requested?requestedNote.ownerSourceId:followUp?.interestedSourceId;
      const clarifyNote=requestedNote.requested&&!followUpNote&&!delegateLearningLookup(requestedNote,admitted),followUpEvidence=followUpNote?f.actions.note(id,followUpNote.id):null;
      const learningReference=followUpEvidence?{noteId:followUpEvidence.id,sourceId:followUpEvidence.sourceId,sourceHash:followUpEvidence.sourceHash,memoryVersion:followUpEvidence.memoryVersion,ownerSourceId:noteOwnerSourceId}:null;
      const learningLookup={requested:requestedNote.requested,reason:requestedNote.reason,ownerSourceId:admitted.at(-1).id,currentOffers:engagement.offers.slice(-3).map(offer=>({messageId:offer.messageId,noteId:offer.noteId,title:offer.title,question:offer.question,text:offer.text})),scope:'Already shared topics only; interpret the current owner input before reading. Not permission to share on a casual turn.'};
      if(requestedNote.requested)j.audit(id,'learning-note-requested',{turn,noteId:followUpNote?.id??null,ownerMessageIds:admitted.map(m=>m.id),reason:requestedNote.reason,matched:!!followUpNote,lane:'foreground'});
      const foregroundNotes=[...new Map([...(followUpNote?[followUpNote]:[]),...store.notes(id)].map(note=>[note.id,note])).values()].slice(0,f.management?.execution(id).context.learningLimit??3);
      const command=recoveredCommand?.receipt??ownerCommand(agent,admitted[0],settings.timeZoneOffsetMinutes);
      if(command&&agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===command.messageId)){phase('idle');return;}
      if(!command&&!clarifyNote){await compactConversation(agent,signal,{turn,epoch,admittedIds:admitted.map(m=>m.id)},modelRequest);valid(agent,signal,epoch);}
      response=command?{rid:crypto.randomUUID(),text:command.text,provider:command.provider,model:'command',localMessageId:command.messageId,reasoningChars:0}:clarifyNote?{rid:crypto.randomUUID(),text:requestedNote.ambiguous?'有几份同名或相近的学习笔记。你想核对哪一份？可以再给一个主题或更完整的标题。':'这次没有唯一定位到那份有效学习笔记。告诉我具体标题或主题，我再核对，不沿用旧网页当作这份笔记。',provider:'local-learning-recall',model:'command',localMessageId:crypto.randomUUID(),reasoningChars:0}:await capabilityDialogue(agent,signal,{request:choiceDialogueRequest(modelRequest),turn,epoch,lane,admittedIds:admitted.map(m=>m.id),messages:contextMessages(agent,'foreground',foregroundSystem(agent,admitted),{persona,input:admitted,history:recentMessages(agent,{lane:'foreground',admittedIds:admitted.map(m=>m.id)}),domain:{},learningLookup,learningConversation:followUpNote?{noteId:followUpNote.id,ownerSourceId:noteOwnerSourceId,kind:'explicit-current-topic-follow-up',reference:learningReference,scope:'只允许就本轮追问展开，不是新的工具或数据授权'}:null,learningNotes:foregroundNotes.map(n=>({id:n.id,title:n.data.title,summary:claimTextProjection(n.data.claims,{maxChars:800}).text,claims:n.data.claims.map(c=>({text:c.text,scope:c.scope??null})),coverage:n.data.coverage??null,source:n.data.source,ownerAnnotation:n.data.ownerRevision??null,feedback:n.feedback}))})});
      valid(agent,signal,epoch,persona.version);
    }else{
      if(!settings.enabled){phase('idle');return;}
      agent.activeLane='autonomous';
      if(j.value(id,'autonomyPaused',false)||j.value(id,'autonomyError',null)){phase('autonomy-paused');return;}
      drainActivityFeedback(f,id);f.goals?.reconcile(id);const next=await candidate(agent,signal,settings);valid(agent,signal,epoch);
      if(!next){const social=socialStatus(j,f.domain,id,settings);j.audit(id,'brain-wait',{reason:'no-eligible-event',turn,social:{reason:social.reason,nextEligibleAt:social.nextEligibleAt,unanswered:social.unanswered}});j.put(id,'autonomyWait','no-eligible-event');phase('waiting');store.completeEvents(id,store.events(id).filter(event=>event.kind!=='plugin').map(event=>event.id));return;}
      if(next.kind==='write-report'){
        try{const action=f.actions.proposeReport(id,{requestId:next.requestId,title:next.title,noteIds:next.noteIds,goal:{id:next.goal.id,stepId:next.goal.stepId}});f.goals.attachAction(id,next.goal,action.id);j.audit(id,'goal-report-prepared',{actionId:action.id,goalId:next.goal.id,title:next.title,lane:'action'});j.put(id,'autonomyWait','action-approval');phase('waiting-approval');}
        catch(error){f.goals.deferCandidate(id,next.goal,/^[A-Z_]{3,64}$/.test(error.message)?error.message:'ACTION_PROPOSAL_FAILED');phase('waiting');}
        return;
      }
      const persona=store.persona(id,'selection');
      task=next.task??store.task(id,next.kind,{...checkpointForOpportunity(next),eventIds:[...store.events(id).filter(event=>event.kind!=='plugin').map(event=>event.id),...next.eventIds??[]],memoryKey:selectionMemoryKey(agent,next.kind)},persona.version);
      if(next.goal&&!next.task)f.goals.attachTask(id,next.goal,task.id);
      if(task.checkpoint.matterId){task=linkMatterTask(agent,task);store.update(task.id,task.status,{...task.checkpoint,memoryKey:selectionMemoryKey(agent,task.kind)});task=store.getTask(task.id);}
      if(task.checkpoint.goal)agent.activeGoalTask=task;agent.activeCognitionTask=task;
      const budget=store.budget(id),estimate=estimateTaskBudget(agent,task);
      if(!quotaAllows(budget,{tokens:estimate.tokens,requests:estimate.requests,roundId:task.checkpoint.roundId??task.id})){store.update(task.id,'waiting-budget');store.requestBudget(id,task.id,estimate);j.put(id,'autonomyWait','autonomous-budget');phase('waiting-budget');return;}
      agent.activeRoundId=task.checkpoint.roundId??task.id;
      const elapsed=roundDuration(j.safety,id,agent.activeRoundId),maxMs=settings.roundTimeoutMs-elapsed;
      if(maxMs<=0){store.update(task.id,'failed',{...task.checkpoint,reason:'AUTONOMOUS_ROUND_TIMEOUT'});store.defer(id,task,'AUTONOMOUS_ROUND_TIMEOUT',settings.sourceIntervalMs);phase('waiting');return;}
      j.put(id,'lastAutonomousFamily',['chat','care'].includes(task.kind)?'social':['research','learn-ai','share-insight'].includes(task.kind)?'learning':'activity');
      segmentStartedMono=performance.now();segment={id:crypto.randomUUID(),agent:id,roundId:agent.activeRoundId,started:Date.now(),maxMs};j.safety.appendSync('segment-start:'+segment.id,'autonomy-segment-start',segment);await j.safety.anchor();
      roundSignal=AbortSignal.timeout(maxMs);signal=AbortSignal.any([parentSignal,roundSignal]);
      j.put(id,'autonomyBudgetRequest',null);j.put(id,'autonomyWait',null);
      if(!task.checkpoint.plan){
        phase('selecting');agent.activeLane='selection';
        const selectionInput=selectionMessages(agent,task,persona);
        store.update(task.id,task.status,{...task.checkpoint,strategyCandidates:selectionInput.strategyCandidates??[]});task=store.getTask(task.id);
        const selection=await modelRequest(agent,signal,{turn,epoch,lane:'selection',taskId:task.id,messages:selectionInput});
        valid(agent,signal,epoch,persona.version);let plan,selectedOpportunity;const selectionTask=task;
        try{
          plan=structured(selection.text);
          if(task.kind==='behavior-choice'){
            const choice=resolveBehaviorChoice(agent,task,plan);plan=choice.plan;
            if(choice.selected){selectedOpportunity=choice.selected;task={...task,kind:choice.selected.kind,checkpoint:{...checkpointForOpportunity(choice.selected),eventIds:[...new Set([...(task.checkpoint.eventIds??[]),...(choice.selected.eventIds??[])])],roundId:agent.activeRoundId,strategyCandidates:selectionTask.checkpoint.strategyCandidates??[],strategyUses:choice.strategyUses??[],memoryKey:selectionMemoryKey(agent,choice.selected.kind)}};}
          }
          // WAIT is a decision to do no work; it needs no invented question or
          // external search query. Keep the older question/value form readable.
          if(plan.decision==='wait'&&typeof plan.reason==='string'&&plan.reason.trim()&&plan.reason.length<=400&&Object.keys(plan).every(k=>['decision','reason'].includes(k)))plan={decision:'wait',question:'',value:plan.reason};
          if(!['execute','wait'].includes(plan.decision))throw contractFailure('decision','invalid-enum-value');
          const unexpected=Object.keys(plan).filter(k=>!['decision','question','value',...(['research','learn-ai'].includes(task.kind)?['learningIntent']:[]),...(task.kind==='research'?['searchQuery','alternateSearchQuery']:[]),...(task.kind==='chat'?['topicKey']:[]),...(task.kind==='behavior'?['input']:[])].includes(k));if(unexpected.length)throw contractFailure('output','unexpected-fields',{unexpectedFieldCount:unexpected.length,knownUnexpectedFields:unexpected.filter(k=>['searchQuery','sourceUrl','source','learningIntent','learning_intent','learningPurpose','reason','kind','topicKey','plan','rationale','version','origin'].includes(k))});
          for(const [field,max] of [['question',240],['value',400]]){if(typeof plan[field]!=='string')throw contractFailure(field,plan[field]===undefined?'required-field-missing':'invalid-field-type',{expectedType:'string'});if(plan[field].length>max)throw contractFailure(field,'field-too-long',{length:plan[field].length,maximum:max});}
          if(plan.decision==='execute'){requireOutputText(plan,'question',240);requireOutputText(plan,'value',400);}
          if((task.checkpoint.goal||task.checkpoint.matterId)&&plan.decision==='execute'&&plan.question.trim()!==task.checkpoint.candidate.question.trim())throw failure(task.checkpoint.goal?'GOAL_DIRECTION_CHANGED':'MATTER_DIRECTION_CHANGED');
          if(task.kind==='behavior'&&plan.decision==='execute'){f.behaviors.validate(agent,task.checkpoint.behaviorId,plan.input,task.checkpoint.behaviorFingerprint);if(task.checkpoint.behaviorInput!==undefined&&!isDeepStrictEqual(plan.input,task.checkpoint.behaviorInput))throw failure('BEHAVIOR_INPUT_CHANGED');}
          if(task.kind==='research'&&plan.decision==='execute'){requireOutputText(plan,'searchQuery',160);searchQuery(plan.searchQuery);if(plan.alternateSearchQuery!==undefined){requireOutputText(plan,'alternateSearchQuery',160);searchQuery(plan.alternateSearchQuery);}}
          if(task.kind==='chat'&&plan.decision==='execute'&&!task.checkpoint.social?.topics.some(t=>t.key===plan.topicKey))throw contractFailure('topicKey','outside-eligible-topics');
          if(task.kind==='chat'&&plan.decision==='execute')assertSocialNovelty(j,id,plan.question,'',Date.now(),settings.socialTopicCooldownMs,{unanswered:task.checkpoint.social?.unanswered??0,domain:f.domain});
          if(task.kind==='share-insight'){assertAgentPerspective(plan.question);assertAgentPerspective(plan.value);}
          if(plan.decision==='execute'&&['research','learn-ai'].includes(task.kind))plan.learningIntent=validateLearningIntent(plan,task);
        }catch(error){
          // An invalid proposal never becomes an executable task or an orphan
          // goal attempt. Commit the chosen kind only after full validation.
          if(selectedOpportunity)task=selectionTask;
          const diagnostic=outputDiagnostic(error,{phase:'selection',text:selection.text});
          j.audit(id,'autonomy-output-rejected',{taskId:task.id,attemptId:selection.rid,phase:'selection',code:error.message,responseHash:key(selection.text),textChars:selection.text.length,validationDiagnostic:diagnostic});
          j.endAttempt(selection.rid,{state:'validation-rejected',usage:selection.usage,usageConfidence:selection.usage?'reported':'unknown',error:error.message,textChars:selection.text.length,reasoningChars:selection.reasoningChars});
          if(['INVALID_BEHAVIOR_SELECTION','INVALID_TOOL_INPUT','INVALID_CAPABILITY_INPUT','BEHAVIOR_INPUT_CHANGED','BEHAVIOR_UNAVAILABLE','BEHAVIOR_DEFINITION_CHANGED','INVALID_TASK_OUTPUT','GOAL_DIRECTION_CHANGED','MATTER_DIRECTION_CHANGED','REPEATED_SOCIAL_TOPIC','SOCIAL_REPLY_PRESSURE','SOCIAL_TASK_ROLE_MISMATCH'].includes(error.message)){store.defer(id,task,error.message,socialDelay(settings,task));store.update(task.id,'failed',{...task.checkpoint,reason:error.message,failureDiagnostic:diagnostic});if(task.kind==='research')j.put(id,'lastResearchAt',Date.now());j.put(id,'autonomyWait',error.message);phase('waiting');return;}throw error;
        }
        if(selectedOpportunity)j.transaction(()=>{f.pluginEvents?.claim(id,task.checkpoint.pluginEventIds??[]);task=store.selectOpportunity(task.id,selectedOpportunity,task.checkpoint);});
        j.audit(id,'direction-selected',{taskId:task.id,roundId:agent.activeRoundId,decision:plan.decision,question:plan.question,value:plan.value,...(plan.topicKey?{topicKey:plan.topicKey}:{}),...(plan.learningIntent?{learningIntent:plan.learningIntent}:{})});
        if(plan.decision==='wait'){if(task.kind==='research')j.put(id,'lastResearchAt',Date.now());store.defer(id,task,'selection-wait',socialDelay(settings,task));store.update(task.id,task.checkpoint.goal?'suspended':'cancelled',{...task.checkpoint,reason:'selection-wait',selectionReason:plan.value});phase('waiting');return;}
        if(['research','learn-ai'].includes(task.kind)){
          const disposition=studyDisposition(j,f.domain,id,plan.question,Date.now()),origin=learningOrigin(task),explicit=['owner-goal','active-matter'].includes(origin)||!!task.checkpoint.correction;
          const studies=j.value(id,'learningRouteStudies',[]).filter(row=>Number.isSafeInteger(row.at)&&Date.now()-row.at<90*86400000),routeKey=disposition.matchedKey??disposition.key,last=studies.find(row=>row.key===routeKey)?.at??0,gap=settings.sourceIntervalMs/Math.max(.25,Math.min(1,disposition.weight));
          if(!explicit&&disposition.weight<1&&Date.now()-last<gap){store.defer(id,task,'learning-route-lower-priority',gap-(Date.now()-last));store.update(task.id,'cancelled',{...task.checkpoint,plan,reason:'learning-route-lower-priority'});j.put(id,'autonomyWait','learning-route-lower-priority');phase('waiting');return;}
          j.put(id,'learningRouteStudies',[...studies.filter(row=>row.key!==routeKey),{key:routeKey,at:Date.now()}].slice(-128));
        }
        j.transaction(()=>{store.update(task.id,'ready',{...task.checkpoint,plan});task=store.getTask(task.id);f.experience?.strategies.bind(id,task,task.checkpoint.strategyUses??[]);});
        if(task.checkpoint.goal&&!f.goals.linked(id,task.id)&&task.kind!=='write-report')f.goals.attachTask(id,task.checkpoint.goal,task.id);
        if(task.checkpoint.goal)agent.activeGoalTask=task;
      }
      j.put(id,'lastAutonomousFamily',['chat','care'].includes(task.kind)?'social':['research','learn-ai','share-insight'].includes(task.kind)?'learning':'activity');
      const workflow=selectedTaskWorkflow(task.kind,agent),work={agent,task,response:null,signal,turn,epoch,phase,valid,modelRequest,discoverSource,rejectInsufficientEvidence,executeModel:current=>new DshTaskExecutor().execute(agent,signal,{task:current,source:current.checkpoint.source,persona:store.persona(id,'execution'),turn,epoch})};
      try{
        if(workflow.prepare&&!await workflow.prepare(work))return;
        task=work.task;
        if(!workflow.direct){
          task=bindMatterTask(agent,task);store.update(task.id,task.status,{...task.checkpoint,memoryKey:selectionMemoryKey(agent,task.kind)});task=store.getTask(task.id);work.task=task;agent.activeCognitionTask=task;
          phase('executing');agent.activeLane='autonomous';store.update(task.id,'executing');valid(agent,signal,epoch,task.persona_version);
        }
        await workflow.execute(work);
      }finally{task=work.task;response=work.response;}
      if(!response)return;
    }
    valid(agent,signal,epoch);
    // Proven source quotations are explicitly attributed to the page, including
    // an author's first person. Free model prose still uses the normal guard.
    if(lane==='foreground'&&!response.localMessageId&&!isSourceGroundedReply(response)){
      try{assertAgentExperience(response.text);}catch(error){
        if(error.message!=='UNSUPPORTED_AGENT_EXPERIENCE')throw error;
        const diagnostic=outputDiagnostic(error,{phase:'execution',text:response.text});
        j.audit(id,'foreground-output-rejected',{attemptId:response.rid,turn,lane:'foreground',code:error.message,responseHash:key(response.text),textChars:response.text.length,validationDiagnostic:diagnostic});
        j.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:error.message,textChars:response.text.length,reasoningChars:response.reasoningChars});
        // Account for the rejected model response once, then commit one local
        // correction through the normal owner-batch/outbox path. No model retry
        // and no global autonomy pause are needed for this isolated bad claim.
        response={rid:crypto.randomUUID(),text:'刚才那种说法不准确，我没有实际做过这件事，不能当作亲身经历。',provider:'local-grounding',model:'command',localMessageId:crypto.randomUUID(),reasoningChars:0};
      }
    }
    const ownerText=lane==='foreground'?admitted.map(m=>m.content.filter(c=>c.type==='text').map(c=>c.text).join('')).join(' '):'';response.text=conversationalText(response.text,conversationOptions(ownerText));if(!response.text)throw failure('EMPTY_MODEL_OUTPUT');
    const message={...createAssistantMessage({content:[{type:'text',text:response.text}],source:{provider:response.provider,model:response.model}}),...(response.localMessageId?{id:response.localMessageId}:{})};
    const data={turn,step:1,message,stream:[],...(response.usage?{usage:response.usage}:{})};
    if(response.workMemoryRefs?.length)j.put(id,'work-observation-message:'+data.message.id,response.workMemoryRefs);
    if(response.noteId)j.put(id,'learning-message:'+data.message.id,response.noteId);
    const offerNote=lane!=='foreground'&&response.noteId?store.offerableNote(id,store.note(id,response.noteId)):null;
    const learningOffer=offerNote?{at:Date.now(),messageId:data.message.id,noteId:offerNote.id,sourceId:offerNote.source_id,ownerAnchor:socialStatus(j,f.domain,id,settings).ownerAnchor,text:response.text,question:offerNote.data.researchQuestion??offerNote.data.title,routeText:(offerNote.data.researchQuestion??'')+' '+offerNote.data.title}:null;
    if(response.localMessageId)j.put(id,'local-admitted:'+data.message.id,admitted.map(m=>m.id));
    bindOwnerResponse(agent,ownerBatch,message.id);
    j.stageResponse(id,response.rid,turn,epoch,'MESSAGE',{data,usage:response.usage,textChars:response.text.length,reasoningChars:response.reasoningChars,...(response.dialogueState?{dialogueCommit:{assistantMessageId:data.message.id,state:response.dialogueState}}:{}),...(response.relationshipDecision?{relationshipCommit:{...response.relationshipDecision,assistantMessageId:data.message.id}}:{}),...(response.learningFollowUp?{learningFollowUpCommit:{...response.learningFollowUp,assistantMessageId:data.message.id}}:{}),...(ownerBatch?{ownerBatch:{id:ownerBatch.id,inputIds:ownerBatch.inputIds}}:{}),...(lane!=='foreground'?{autonomyCommit:{contactAt:Date.now(),noteId:response.noteId??null,...(learningOffer?{learningOffer}:{}),careAnchor:task?.kind==='care'?task.checkpoint.anchor:null,social:{at:Date.now(),messageId:data.message.id,taskId:task?.id,kind:task?.kind??'autonomous',topicKey:task?.checkpoint.plan?.topicKey??(response.noteId?'insight:'+response.noteId:task?.kind??'autonomous'),question:task?.checkpoint.plan?.question?.slice(0,240)??'',ownerAnchor:socialStatus(j,f.domain,id,settings).ownerAnchor}}}:{})});stageId=response.rid;
    valid(agent,signal,epoch);agent.session.append('assistant/message',data,{surfaceOp:'append'});await agent.flush();j.reconcile(agent.session);
    j.put(id,'lastError',null);store.completeEvents(id,task?.checkpoint.eventIds??[]);phase('idle');
  }catch(error){
    const roundTimeout=roundSignal?.aborted&&!parentSignal.aborted;
    const code=roundTimeout?'AUTONOMOUS_ROUND_TIMEOUT':parentSignal.aborted?'USER_PREEMPTED':error.code??error.message;
    if(ownerBatch){if(parentSignal.aborted||code==='CONTEXT_BUDGET_TOO_SMALL')restoreOwnerBatch(agent,ownerBatch);else j.put(id,'ownerBatch',{...ownerBatch,failed:true});}
    if(code==='CONTEXT_BUDGET_TOO_SMALL'&&lane==='foreground')for(const message of [...admitted].reverse())if(![...agent.inbox.nextTurn,...agent.inbox.nextStep].some(m=>m.id===message.id))agent.inbox.prepend('next-turn',message);
    if(task&&store.getTask(task.id)?.status!=='completed')store.update(task.id,parentSignal.aborted?'suspended':code==='MATTER_NO_LONGER_ACTIVE'?'cancelled':code==='AUTONOMOUS_BUDGET_EXHAUSTED'?'waiting-budget':'failed',{...store.getTask(task.id).checkpoint,reason:/^[A-Z_]{3,64}$/.test(code)?code:'TASK_EXECUTION_FAILED'});
    if(code==='GOAL_NO_LONGER_ACTIVE'||code==='MATTER_NO_LONGER_ACTIVE'){j.put(id,'autonomyWait',code);phase('waiting');}
    else if(task?.kind==='behavior'||['INVALID_BEHAVIOR_SELECTION','BEHAVIOR_UNAVAILABLE','BEHAVIOR_DEFINITION_CHANGED','BEHAVIOR_INPUT_CHANGED'].includes(code)){if(task)store.defer(id,task,code,settings.sourceIntervalMs);j.put(id,'autonomyWait',code);phase('waiting');}
    else if(roundTimeout){store.defer(id,task,'AUTONOMOUS_ROUND_TIMEOUT',settings.sourceIntervalMs);j.put(id,'autonomyWait','AUTONOMOUS_ROUND_TIMEOUT');phase('waiting');}
    else if(parentSignal.aborted){reason=agent.cause?.kind==='owner-supplement'?{kind:'completed'}:{kind:'aborted',reason:agent.cause??{kind:'user'}};phase('preempted');}
    else if(code==='AUTONOMOUS_BUDGET_EXHAUSTED'){const estimate=task?estimateTaskBudget(agent,store.getTask(task.id)):{tokens:0,requests:1};store.requestBudget(id,task?.id??'new-task',autonomousBudgetEstimate(estimate,error.neededTokens));j.put(id,'autonomyWait','autonomous-budget');phase('waiting-budget');}
    else{reason={kind:'error',error:{code:'HUMAN_AUTONOMY_ERROR',message:/^[A-Z_]{3,64}$/.test(code)?code:'TASK_EXECUTION_FAILED'}};if(lane==='foreground'){j.put(id,'lastError',reason.error.message);j.set(id,'paused');j.put(id,'stopReason','error');agent.wake=false;clearTimeout(agent.timer);agent.timer=undefined;}else{j.put(id,'autonomyError',reason.error.message);j.put(id,'autonomyPaused',true);phase('autonomy-error');}}
    j.audit(id,'autonomy-turn-ended',{turn,lane,taskId:task?.id,contextBudget:error.context??null,code:/^[A-Z_]{3,64}$/.test(code)?code:'TASK_EXECUTION_FAILED'});
  }finally{
    if(segment){j.safety.appendSync('segment-end:'+segment.id,'autonomy-segment-end',{...segment,used:Math.min(segment.maxMs,Math.max(0,Math.round(performance.now()-segmentStartedMono)))});await j.safety.anchor();}agent.activeRoundId=undefined;
    if(stageId){const row=j.db.prepare('SELECT payload FROM response_stage WHERE id=?').get(stageId);const payload=row?.payload&&JSON.parse(row.payload);const committed=payload?.data&&agent.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===payload.data.message.id);if(!committed){j.db.prepare("UPDATE response_stage SET state='discarded',payload='null' WHERE id=?").run(stageId);j.endAttempt(stageId,{state:'cancelled',usageConfidence:'unknown',error:'STALE_RESPONSE'});stageId=null;}}
    if(entered)agent.session.append('step/end',{turn,step:1});agent.session.append('turn/end',{turn,reason});await agent.flush();finishOwnerBatch(agent,ownerBatch);if(stageId)j.commitResponse(stageId);j.reconcile(agent.session);
    if(response&&!stageId&&lane==='foreground')j.endAttempt(response.rid,{state:signal.aborted?'cancelled':'failed',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:'RESPONSE_NOT_COMMITTED'});
    if(remaining!==null&&!(parentSignal.aborted&&agent.cause?.kind==='owner-supplement')){j.put(id,'remaining',Math.max(0,remaining-1));if(remaining<=1&&agent.desired().desired==='running'){j.set(id,'paused');j.put(id,'stopReason','cycle-limit');clearTimeout(agent.timer);agent.timer=undefined;}}
    agent.activeGoalTask=undefined;agent.activeCognitionTask=undefined;
    try{drainActivityFeedback(f,id);reconcileCognition(agent,task,{feedback:false});}catch(error){j.audit(id,'cognition-reconcile-held',{taskId:task?.id,code:/^[A-Z_]+$/.test(error.message)?error.message:'COGNITION_RECONCILE_FAILED'});}
    agent.activeLane=undefined;if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length||pendingOwnerCommand(agent)||nextActionWork(agent))agent.wake=true;
  }
}
