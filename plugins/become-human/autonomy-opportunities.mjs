import {createHash} from 'node:crypto';
import {syncCapabilityBehaviors,behaviorTaskReady} from './capability-behaviors.mjs';
import {choiceOpportunity,checkpointForOpportunity} from './behavior-selection.mjs';
import {boardCandidate,matterAllowed} from './cognition-runtime.mjs';
import {isLearningActivity,learningCheckpointPolicy,resetLearningPlan,selectionSchemaVersion,LearningPack} from './learning-pack.mjs';
import {collectContactOpportunities,careQuestion} from './contact-opportunities.mjs';
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
export const selectionMemoryKey=(agent,kind)=>key(JSON.stringify({learningPolicyVersion:selectionSchemaVersion(kind),relationship:agent.factory.relationship?.context(agent.id)??null,persona:agent.factory.autonomy.persona(agent.id),developmentVersion:agent.factory.personaDevelopment?.snapshot(agent.id).version??null,cognitionRevision:agent.factory.cognition?.selectionRevision(agent.id)??null,workMemoryRefs:['chat','care'].includes(kind)?agent.factory.workObservation?.context(agent.id,{limit:2}).map(row=>[row.id,row.version])??[]:[],memories:agent.factory.domain.list(agent.id,{limit:20}).map(m=>({id:m.id,version:m.version}))}));

export async function candidate(agent,signal,settings,now=Date.now()){
  const store=agent.factory.autonomy,j=agent.factory.journal,id=agent.id,pack=agent.factory.learningPack??new LearningPack();
  settings={...settings,learningEnabled:pack.available(settings)};
  syncCapabilityBehaviors(agent.factory,id);signal.throwIfAborted();
  const lastUserEvent=agent.session.snapshotEvents().findLast(e=>e.type==='user/message'),lastUser=lastUserEvent?{id:lastUserEvent.data.id,time:lastUserEvent.time}:null;
  const anchor=lastUser?.id??'initial:'+store.persona(id,'selection').version,social=socialStatus(j,agent.factory.domain,id,settings,now,lastUser),chat=socialCandidate(j,agent.factory.domain,id,settings,now,lastUser);
  const userTime=lastUser?.time??j.value(id,'autonomyActivatedAt',now),contactReady=!store.quiet(settings,now)&&now-Math.max(j.value(id,'lastAutonomousContact',0),userTime)>=settings.contactCooldownMs&&(!settings.socialEnabled||social.canContact);
  const after=j.value(id,'pendingTaskCursor',null);
  const rows=store.pendingTasks?.(id,{after,limit:32})??[store.pending(id)].filter(Boolean);
  const personaVersion=rows.length?store.persona(id,'selection').version:null;
  for(const row of rows){
    let task=store.getTask(row.id);
    if(holdUnavailableBehavior(agent,task)||pack.hold(agent,task,settings))continue;
    if(task.checkpoint.learningHold||task.checkpoint.behaviorHold)task=store.getTask(row.id);
    const cp=task.checkpoint,policy=learningCheckpointPolicy(agent,task,{settings,now,contactReady});
    const allowed=policy?policy.allowed:task.kind==='write-report'||task.kind==='behavior'||task.kind==='care'&&settings.proactiveEnabled&&cp.anchor===anchor||task.kind==='chat'&&settings.proactiveEnabled&&settings.socialEnabled&&cp.anchor===social.anchor;
    if(!allowed||task.persona_version!==personaVersion||!matterAllowed(agent,task)||agent.factory.goals&&!agent.factory.goals.taskAllowed(id,task)||cp.pluginEventIds?.length&&!agent.factory.pluginEvents?.valid(id,cp.pluginEventIds)){
      store.update(task.id,'cancelled',{...cp,reason:'context-or-behavior-changed'});continue;
    }
    if(store.deferred(id,cp,now))continue;
    let ready=policy?.ready;
    if(!policy){
      if(task.kind==='behavior')ready=behaviorTaskReady(agent,task)&&agent.factory.behaviors.readyToResume?.(agent,task,now)!==false;
      else ready=task.kind==='write-report'||(task.kind==='chat'?social.ready:contactReady);
    }
    if(!ready)continue;
    // A submitted capability must keep its exact input and idempotency key.
    if(task.kind!=='behavior'){
      const memoryKey=selectionMemoryKey(agent,task.kind),socialChanged=task.kind==='chat'&&chat&&key(JSON.stringify(cp.social))!==key(JSON.stringify(chat.social));
      if(cp.memoryKey!==memoryKey||policy?.replan||socialChanged){
        const checkpoint={...cp,memoryKey};delete checkpoint.plan;
        if(task.kind==='care')checkpoint.candidate={...cp.candidate,question:careQuestion};
        if(task.kind==='chat'&&chat)checkpoint.social=chat.social;
        resetLearningPlan(task.kind,checkpoint);
        store.update(task.id,'ready',checkpoint);
        j.audit(id,'autonomy-plan-invalidated',{taskId:task.id,reason:policy?.replan??'selection-context-changed'});
      }
    }
    if(rows.length>1)j.put(id,'pendingTaskCursor',row);
    return {task:store.getTask(task.id)};
  }
  if(rows.length===32)j.put(id,'pendingTaskCursor',rows.at(-1));
  agent.factory.plugins?.selection({id:'selection:'+now,phase:'selection',now});
  const opportunities=[];
  const offer=next=>{if(next&&(next.kind!=='write-report'||pack.provider)&&(!isLearningActivity(next.kind)||pack.available(settings))&&!store.deferred(id,checkpointForOpportunity(next),now))opportunities.push(next);};
  offer(chat);offer(agent.factory.goals?.candidate(id,settings,now));offer(boardCandidate(agent,settings,{chat,now}));
  // Build opportunities without network access. Only the chosen source is
  // fetched, after a model decision and current budget/permission checks.
  pack.collect(agent,{settings,now,offer,contactReady});
  collectContactOpportunities(agent,{settings,now,offer,contactReady,anchor});
  // One scheduler scan advances event visibility, even when a provider has no
  // useful action. Read-only status queries never change this cursor.
  for(const next of agent.factory.behaviors?.opportunities(agent,{now,settings,events:store.events(id,{advance:true})})??[])offer(next);
  const profile=store.persona(id,'selection').profile;
  return choiceOpportunity(opportunities,{journal:j,agentId:id,toolFocus:[profile?.goals,profile?.interests].flat().filter(Boolean).join('\n')});
}
