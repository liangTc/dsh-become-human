import {learningOpportunitySnapshot,learningExecutionContext} from './learning-service.mjs';
import {routeDisposition,studyDisposition} from './learning-engagement.mjs';
import {ownerAttributionRisk,assertAgentPerspective,requireOutputText} from './learning.mjs';
import {learningOrigin,validateLearningIntent,learningPolicyVersion} from './learning-policy.mjs';
import {searchQuery} from './research.mjs';
import {checkpointForOpportunity} from './behavior-selection.mjs';

export const learningKinds=new Set(['research','learn-ai']);
export const isLearningActivity=kind=>learningKinds.has(kind)||kind==='share-insight';
// Older persisted hashes use the property learningPolicyVersion for all tasks.
// Keep those keys readable; future learning revisions only invalidate learning.
export const selectionSchemaVersion=kind=>isLearningActivity(kind)?learningPolicyVersion:3;
export function learningPlanFields(kind){
  if(kind==='research')return ['learningIntent','searchQuery','alternateSearchQuery'];
  return kind==='learn-ai'?['learningIntent']:[];
}
export function validateLearningPlan(task,plan){
  if(task.kind==='share-insight'){assertAgentPerspective(plan.question);assertAgentPerspective(plan.value);}
  if(!learningKinds.has(task.kind)||plan.decision!=='execute')return;
  if(task.kind==='research'){
    requireOutputText(plan,'searchQuery',160);searchQuery(plan.searchQuery);
    if(plan.alternateSearchQuery!==undefined){requireOutputText(plan,'alternateSearchQuery',160);searchQuery(plan.alternateSearchQuery);}
  }
  plan.learningIntent=validateLearningIntent(plan,task);
}
export function admitLearningRoute(agent,task,plan,settings,now=Date.now()){
  if(!learningKinds.has(task.kind))return true;
  const {journal,domain,autonomy}=agent.factory,id=agent.id;
  const disposition=studyDisposition(journal,domain,id,plan.question,now);
  const explicit=['owner-goal','active-matter'].includes(learningOrigin(task))||!!task.checkpoint.correction;
  const studies=journal.value(id,'learningRouteStudies',[]).filter(row=>Number.isSafeInteger(row.at)&&now-row.at<90*86400000);
  const route=disposition.matchedKey??disposition.key,last=studies.find(row=>row.key===route)?.at??0;
  const gap=settings.sourceIntervalMs/Math.max(.25,Math.min(1,disposition.weight));
  if(!explicit&&disposition.weight<1&&now-last<gap){
    const reason='learning-route-lower-priority';
    autonomy.defer(id,task,reason,gap-(now-last),now);
    autonomy.update(task.id,'cancelled',{...task.checkpoint,plan,reason});journal.put(id,'autonomyWait',reason);
    return false;
  }
  journal.put(id,'learningRouteStudies',[...studies.filter(row=>row.key!==route),{key:route,at:now}].slice(-128));return true;
}

function shareOpportunity(agent,{settings,contactReady,now,offer}){
  if(!settings.proactiveEnabled||!contactReady)return;
  const {autonomy:store,journal,domain}=agent.factory,id=agent.id;
  let cursor=journal.value(id,'learningShareScanCursor',null);
  for(let page=0;page<5;page++){
    const batch=store.shareCandidates(id,{limit:20,cursor});
    for(const note of batch.items){
      const route=(note.data.researchQuestion??'')+' '+note.data.title;
      if(routeDisposition(journal,domain,id,route,now).cooldownUntil>now)continue;
      const next={kind:'share-insight',noteId:note.id,question:'围绕已有笔记 '+note.data.title+' 自然带起一个话题，先给引子，不推送知识正文。'};
      if(store.deferred(id,checkpointForOpportunity(next),now))continue;
      offer(next);journal.put(id,'learningShareScanCursor',null);return;
    }
    cursor=batch.nextCursor;if(!cursor)break;
  }
  journal.put(id,'learningShareScanCursor',cursor);
}

export function learningOfferReceipt(agent,response,messageId,ownerAnchor,at){
  if(!response.noteId)return null;
  const store=agent.factory.autonomy,note=store.offerableNote(agent.id,store.note(agent.id,response.noteId));
  if(!note)return null;
  return {at,messageId,noteId:note.id,sourceId:note.source_id,ownerAnchor,text:response.text,
    question:note.data.researchQuestion??note.data.title,routeText:(note.data.researchQuestion??'')+' '+note.data.title};
}

// Legacy learning checkpoints are durable even when no provider is installed.
// Only the adapter interprets their source, correction, sharing and draft fields.
export function learningCheckpointPolicy(agent,task,{settings,now,contactReady}){
  if(!isLearningActivity(task.kind))return null;
  const {autonomy:store,journal:j,domain}=agent.factory,id=agent.id,cp=task.checkpoint;
  const sourceUrl=cp.sourceSpec?.url??cp.source?.requestedUrl;
  if(cp.correction&&store.correction(id,sourceUrl??cp.source?.url)?.revision!==cp.correction.revision)return {allowed:false};
  if(task.kind==='research'){
    const missingQuery=cp.plan&&!cp.source&&typeof cp.plan.searchQuery!=='string';
    return {allowed:settings.searchEnabled,ready:true,replan:missingQuery?'selection-context-changed':null};
  }
  if(task.kind==='learn-ai')return {allowed:settings.sources.some(s=>s.url===sourceUrl)||settings.searchEnabled&&!!cp.source?.discovery,ready:true};
  const note=cp.noteId?store.offerableNote(id,store.note(id,cp.noteId)):null;
  if(!settings.proactiveEnabled||!note||note.feedback?.value==='not-now'||j.value(id,'learning-shared:'+note.id,false))return {allowed:false};
  const route=(note.data.researchQuestion??'')+' '+note.data.title;
  const unsupported=cp.plan&&ownerAttributionRisk(cp.plan.question+' '+cp.plan.value);
  return {allowed:!(routeDisposition(j,domain,id,route,now).cooldownUntil>now),ready:contactReady,replan:unsupported?'unsupported-owner-attribution':null};
}

export function resetLearningPlan(kind,checkpoint){
  if(!isLearningActivity(kind))return;
  delete checkpoint.learningDraft;
  if(kind==='research'){delete checkpoint.discovery;delete checkpoint.researchReads;checkpoint.source=null;}
}
// Migration adapter for durable pre-pack tasks. New third-party actions still
// use humanBehaviors. There is deliberately no bundled/default provider.
export class LearningPack {
  constructor(registerCapabilities){this.provider=null;this.registerCapabilities=registerCapabilities;}
  register(descriptor){
    if(this.provider||descriptor?.version!==1||['collect','prepare','execute'].some(k=>typeof descriptor[k]!=='function'))throw Error('INVALID_LEARNING_PACK');
    const provider=Object.freeze({...descriptor});
    const release=this.registerCapabilities?.();
    this.provider=provider;
    return ()=>{
      if(this.provider!==provider)return;
      this.provider=null;
      release?.();
    };
  }
  catalog(){return this.provider?[{id:'deep-learning',version:1,title:'探索与学习',kind:'optional-workflow',taskKinds:[...learningKinds]}]:[];}
  available(settings){return !!this.provider&&settings.learningEnabled===true;}
  collect(agent,snapshot){
    if(!this.available(snapshot.settings))return;
    let rows;
    try{rows=this.provider.collect(learningOpportunitySnapshot(agent,snapshot));
      if(!Array.isArray(rows)||rows.length>32||rows.some(row=>!learningKinds.has(row?.kind)||typeof row.question!=='string'||!row.question.trim()||row.question.length>240))throw Error('INVALID_LEARNING_OPPORTUNITIES');
    }catch(error){agent.factory.journal.audit(agent.id,'learning-provider-held',{code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'LEARNING_PROVIDER_FAILED'});rows=[];}
    for(const row of rows)snapshot.offer(row);
    shareOpportunity(agent,snapshot);
  }
  hold(agent,task,settings){
    const isReport=task.kind==='write-report';
    if(!isLearningActivity(task.kind)&&!isReport)return false;
    const version=task.checkpoint.learningPackVersion??1;
    const reason=!this.provider?'LEARNING_PACK_UNAVAILABLE':!isReport&&!settings.learningEnabled?'LEARNING_DISABLED':version!==this.provider.version?'LEARNING_PACK_CHANGED':null;
    const store=agent.factory.autonomy;
    if(reason){if(task.checkpoint.learningHold!==reason){store.update(task.id,'suspended',{...task.checkpoint,learningHold:reason});agent.factory.journal.audit(agent.id,'learning-task-held',{taskId:task.id,code:reason});}return true;}
    if(task.checkpoint.learningHold){const {learningHold,...checkpoint}=task.checkpoint;store.update(task.id,task.status,checkpoint);}
    return false;
  }
  workflow(){
    const provider=this.provider;if(!provider)throw Error('LEARNING_PACK_UNAVAILABLE');
    const invoke=async(name,ctx)=>{
      const guard=()=>{ctx.valid(ctx.agent,ctx.signal,ctx.epoch,ctx.task.persona_version);if(this.provider!==provider||!this.available(ctx.agent.factory.autonomy.settings(ctx.agent.id)))throw Error('LEARNING_PACK_UNAVAILABLE');if((ctx.task.checkpoint.learningPackVersion??1)!==provider.version)throw Error('LEARNING_PACK_CHANGED');};
      guard();const scoped=learningExecutionContext(ctx,guard);
      return provider[name](scoped);
    };
    return {prepare:ctx=>invoke('prepare',ctx),execute:ctx=>invoke('execute',ctx)};
  }
}
