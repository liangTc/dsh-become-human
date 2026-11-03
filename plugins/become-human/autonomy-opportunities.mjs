import {createHash} from 'node:crypto';
import {syncCapabilityBehaviors,behaviorTaskReady} from './capability-behaviors.mjs';
import {choiceOpportunity,checkpointForOpportunity} from './behavior-selection.mjs';
import {boardCandidate,matterAllowed} from './cognition-runtime.mjs';
import {learningPolicyVersion} from './learning-policy.mjs';
import {routeDisposition} from './learning-engagement.mjs';
import {learningKinds,LearningPack} from './learning-pack.mjs';
import {collectContactOpportunities,careQuestion} from './contact-opportunities.mjs';
import {ownerAttributionRisk} from './learning.mjs';
import {socialStatus,socialCandidate} from './social.mjs';
const key=value=>createHash('sha256').update(value).digest('hex');

// Package disable or replacement must not discard a durable plan. A matching
// provider may resume it later; a changed contract requires explicit replanning.
function holdUnavailableBehavior(agent,task){
  if(task.kind!=='behavior')return false;
  const definition=agent.factory.behaviors?.definition(agent,task.checkpoint.behaviorId);
  const reason=!definition?'BEHAVIOR_UNAVAILABLE':definition.fingerprint!==task.checkpoint.behaviorFingerprint?'BEHAVIOR_DEFINITION_CHANGED':null;
  const store=agent.factory.autonomy;
  if(reason){if(task.checkpoint.behaviorHold!==reason){store.update(task.id,'suspended',{...task.checkpoint,behaviorHold:reason});agent.factory.journal.audit(agent.id,'behavior-task-held',{taskId:task.id,behaviorId:task.checkpoint.behaviorId,code:reason});}return true;}
  if(task.checkpoint.behaviorHold){const {behaviorHold,...checkpoint}=task.checkpoint;store.update(task.id,task.status,checkpoint);}
  return false;
}

// Collect eligible work and resume exact checkpoints; no model or network I/O.
// Selection, execution and delivery remain under the driver's single lane.
// Includes the context schema and full active profile so cached plans from an
// older hidden persona are reselected without retrying failed tasks.
export const selectionMemoryKey=(agent,kind)=>key(JSON.stringify({learningPolicyVersion,relationship:agent.factory.relationship?.context(agent.id)??null,persona:agent.factory.autonomy.persona(agent.id),developmentVersion:agent.factory.personaDevelopment?.snapshot(agent.id).version??null,cognitionRevision:agent.factory.cognition?.selectionRevision(agent.id)??null,workMemoryRefs:['chat','care'].includes(kind)?agent.factory.workObservation?.context(agent.id,{limit:2}).map(row=>[row.id,row.version])??[]:[],memories:agent.factory.domain.list(agent.id,{limit:20}).map(m=>({id:m.id,version:m.version}))}));

export async function candidate(agent,signal,settings,now=Date.now()){
  const store=agent.factory.autonomy,j=agent.factory.journal,id=agent.id,pack=agent.factory.learningPack??new LearningPack();
  settings={...settings,learningEnabled:pack.available(settings)};
  syncCapabilityBehaviors(agent.factory,id);signal.throwIfAborted();
  const lastUserEvent=agent.session.snapshotEvents().findLast(e=>e.type==='user/message'),lastUser=lastUserEvent?{id:lastUserEvent.data.id,time:lastUserEvent.time}:null;
  const anchor=lastUser?.id??'initial:'+store.persona(id,'selection').version,social=socialStatus(j,agent.factory.domain,id,settings,now,lastUser),chat=socialCandidate(j,agent.factory.domain,id,settings,now,lastUser);
  const userTime=lastUser?.time??j.value(id,'autonomyActivatedAt',now),contactReady=!store.quiet(settings,now)&&now-Math.max(j.value(id,'lastAutonomousContact',0),userTime)>=settings.contactCooldownMs&&(!settings.socialEnabled||social.canContact);
  const pending=(store.pendingTasks?.(id)??[store.pending(id)].filter(Boolean)).find(row=>!holdUnavailableBehavior(agent,store.getTask(row.id))&&!pack.hold(agent,store.getTask(row.id),settings));
  if(pending){
    const task=store.getTask(pending.id),learning=['research','learn-ai'].includes(task.kind),note=task.checkpoint.noteId?store.note(id,task.checkpoint.noteId):null;
    const allowed=task.kind==='behavior-choice'?false:task.kind==='behavior'?agent.factory.behaviors?.available(agent,task.checkpoint.behaviorId):task.kind==='research'?settings.learningEnabled&&settings.searchEnabled:task.kind==='learn-ai'?settings.learningEnabled&&(settings.sources.some(s=>s.url===(task.checkpoint.sourceSpec?.url??task.checkpoint.source?.requestedUrl))||settings.searchEnabled&&!!task.checkpoint.source?.discovery):task.kind==='write-report'?true:settings.proactiveEnabled;
    const changed=!allowed||(task.checkpoint.pluginEventIds?.length&&!agent.factory.pluginEvents?.valid(id,task.checkpoint.pluginEventIds))||!matterAllowed(agent,task)||agent.factory.goals&&!agent.factory.goals.taskAllowed(id,task)||task.persona_version!==store.persona(id,'selection').version||task.checkpoint.noteId&&(!note||note.feedback?.value==='not-now'||j.value(id,'learning-shared:'+note.id,false))||task.kind==='care'&&task.checkpoint.anchor!==anchor||task.kind==='chat'&&(!settings.socialEnabled||task.checkpoint.anchor!==social.anchor)||task.checkpoint.correction&&store.correction(id,task.checkpoint.sourceSpec?.url??task.checkpoint.source?.requestedUrl??task.checkpoint.source?.url)?.revision!==task.checkpoint.correction.revision;
    const outreach=task.kind==='share-insight'&&note?routeDisposition(j,agent.factory.domain,id,(note.data.researchQuestion??'')+' '+note.data.title,now):null;
    if(changed||task.kind==='share-insight'&&(!store.offerableNote(id,note)||outreach?.cooldownUntil>now))store.update(task.id,'cancelled',{...task.checkpoint,reason:'context-or-behavior-changed'});
    else if(!store.deferred(id,task.checkpoint,now)&&(task.kind==='behavior'?behaviorTaskReady(agent,task):learning||task.kind==='write-report'||(task.kind==='chat'?social.ready:contactReady))){
      const memoryKey=selectionMemoryKey(agent,task.kind);
      // Once a capability has been submitted, preserve its exact input and
      // idempotency key across owner input and approval. Never re-plan it.
      const unsupportedPlan=task.kind==='share-insight'&&task.checkpoint.plan&&ownerAttributionRisk(task.checkpoint.plan.question+' '+task.checkpoint.plan.value);
      const missingSearchQuery=task.kind==='research'&&!task.checkpoint.source&&task.checkpoint.plan&&typeof task.checkpoint.plan.searchQuery!=='string';
      const socialChanged=task.kind==='chat'&&chat&&key(JSON.stringify(task.checkpoint.social))!==key(JSON.stringify(chat.social));
      if(task.kind!=='behavior'&&(task.checkpoint.memoryKey!==memoryKey||unsupportedPlan||missingSearchQuery||socialChanged)){const checkpoint={...task.checkpoint,memoryKey,...(task.kind==='care'?{candidate:{...task.checkpoint.candidate,question:careQuestion}}:{}),...(task.kind==='chat'&&chat?{social:chat.social}:{})};delete checkpoint.plan;delete checkpoint.learningDraft;if(task.kind==='research'){delete checkpoint.discovery;delete checkpoint.researchReads;checkpoint.source=null;}store.update(task.id,'ready',checkpoint);j.audit(id,'autonomy-plan-invalidated',{taskId:task.id,reason:unsupportedPlan?'unsupported-owner-attribution':'selection-context-changed'});}
      return {task:store.getTask(task.id)};
    }
  }
  const opportunities=[];
  const offer=next=>{if(next&&(!(learningKinds.has(next.kind)||next.kind==='share-insight')||pack.available(settings))&&!store.deferred(id,checkpointForOpportunity(next),now))opportunities.push(next);};
  offer(chat);offer(agent.factory.goals?.candidate(id,settings,now));offer(boardCandidate(agent,settings,{chat,now}));
  // Build opportunities without network access. Only the chosen source is
  // fetched, after a model decision and current budget/permission checks.
  pack.collect(agent,{settings,now,offer});
  collectContactOpportunities(agent,{settings,now,offer,contactReady,anchor});
  // One scheduler scan advances event visibility, even when a provider has no
  // useful action. Read-only status queries never change this cursor.
  for(const next of agent.factory.behaviors?.opportunities(agent,{now,settings,events:store.events(id,{advance:true})})??[])offer(next);
  return choiceOpportunity(opportunities,{journal:j,agentId:id});
}
