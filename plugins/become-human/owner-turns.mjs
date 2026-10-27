import {parseScheduleIntent} from './schedule-intent.mjs';
import {parseGoalCommand} from './goal-command.mjs';
import {mediaPolicy} from './multimodal.mjs';

export const conversationDefaults=Object.freeze({enabled:true,quietMs:4000,maxWaitMs:15000,replyBubbles:true,replyGapMs:900});
export const conversationSettings=(journal,id)=>({...conversationDefaults,...journal.value(id,'humanExecution',{}).conversation});
export function validateConversationSettings(value,current=conversationDefaults){
  if(!value||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.quietMs)||value.quietMs<500||value.quietMs>10000||!Number.isSafeInteger(value.maxWaitMs)||value.maxWaitMs<2000||value.maxWaitMs>30000||value.maxWaitMs<value.quietMs)throw new Error('INVALID_CONFIGURATION');
  const replyBubbles=value.replyBubbles===undefined?(current.replyBubbles??conversationDefaults.replyBubbles):value.replyBubbles,replyGapMs=value.replyGapMs===undefined?(current.replyGapMs??conversationDefaults.replyGapMs):value.replyGapMs;
  if(typeof replyBubbles!=='boolean'||!Number.isSafeInteger(replyGapMs)||replyGapMs<300||replyGapMs>3000)throw new Error('INVALID_CONFIGURATION');
  return {enabled:value.enabled,quietMs:value.quietMs,maxWaitMs:value.maxWaitMs,replyBubbles,replyGapMs};
}
const textOf=m=>(m.content??[]).filter(c=>c.type==='text').map(c=>c.text??'').join('');
const flushText=text=>/^(?:说完了|先这样|可以回复了|你说吧)[。！!]?$/u.test(text.trim());
// Pure recognition only: joining messages must never create a command or grant.
export function immediateOwnerMessage(agent,message){
  const text=textOf(message),offset=agent.factory.autonomy.settings(agent.id).timeZoneOffsetMinutes;
  return /^\s*\//u.test(text)||!!parseGoalCommand(text)||!!parseScheduleIntent(text,{timeZoneOffsetMinutes:offset});
}
function arrival(agent,message,now){
  const event=agent.session.snapshotEvents().find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.id===message.id));
  return Number.isFinite(event?.time)?Math.min(now,event.time):now;
}
export function ownerTurnPlan(agent,now=Date.now()){
  const target=agent.inbox.nextStep.length?'next-step':'next-turn',queue=target==='next-step'?agent.inbox.nextStep:agent.inbox.nextTurn;
  if(!queue.length)return null;
  const settings=conversationSettings(agent.factory.journal,agent.id),command=target==='next-step'||immediateOwnerMessage(agent,queue[0]);
  const messages=[];let chars=0,imageCount=0,imageBytes=0,boundary=false;
  for(const message of queue){
    if(messages.length&&(command||immediateOwnerMessage(agent,message))){boundary=true;break;}
    const images=(message.content??[]).filter(part=>part.type==='image'),size=textOf(message).length,bytes=images.reduce((sum,part)=>sum+(part.attachment?.bytes??0),0);
    if(messages.length&&(messages.length>=8||chars+size>4096||imageCount+images.length>mediaPolicy.maxPerMessage||imageBytes+bytes>mediaPolicy.maxMessageBytes)){boundary=true;break;}
    messages.push(message);chars+=size;imageCount+=images.length;imageBytes+=bytes;if(command||!settings.enabled)break;
  }
  const times=messages.map(m=>arrival(agent,m,now)),firstAt=Math.min(...times),lastAt=Math.max(...times),deadlineAt=firstAt+settings.maxWaitMs;
  const dueAt=command||!settings.enabled||boundary||messages.length>=8||chars>=4096||flushText(textOf(messages.at(-1)))?now:Math.min(lastAt+settings.quietMs,deadlineAt);
  return {target,messages,command,firstAt,lastAt,deadlineAt,dueAt,delayMs:Math.max(0,dueAt-now)};
}
export function beginOwnerBatch(agent,plan,turn){
  if(!plan||plan.command)return null;
  const batch={id:crypto.randomUUID(),turn,target:plan.target,inputIds:plan.messages.map(m=>m.id),firstAt:plan.firstAt,deadlineAt:plan.deadlineAt,invalidated:false};
  agent.factory.journal.put(agent.id,'ownerBatch',batch);agent.ownerBatch=batch;
  agent.factory.journal.audit(agent.id,'owner-input-batched',{batchId:batch.id,inputIds:batch.inputIds,count:batch.inputIds.length,lane:'foreground',origin:'owner'});
  return batch;
}
export function supersedeOwnerBatch(agent,target,message,now=Date.now()){
  const j=agent.factory.journal,batch=j.value(agent.id,'ownerBatch',null),settings=conversationSettings(j,agent.id);
  if(!settings.enabled||agent.desired().desired!=='running'||!agent.active||agent.activeLane!=='foreground'||!batch||batch.failed||batch.target!==target||target==='next-step'||now>=batch.deadlineAt||immediateOwnerMessage(agent,message))return false;
  const pending=[...agent.inbox.nextTurn,...agent.inbox.nextStep];
  if(batch.inputIds.length+pending.length+1>8)return false;
  const events=agent.session.snapshotEvents(),all=new Map();for(const e of events){if(e.type==='user/message')all.set(e.data.id,e.data);if(e.type==='agent/inbox/spliced')for(const m of e.data.inserted??[])all.set(m.id,m);}
  if([...batch.inputIds.map(id=>all.get(id)).filter(Boolean),...pending,message].reduce((n,m)=>n+textOf(m).length,0)>4096)return false;
  const images=[...batch.inputIds.map(id=>all.get(id)).filter(Boolean),...pending,message].flatMap(m=>(m.content??[]).filter(part=>part.type==='image'));
  if(images.length>mediaPolicy.maxPerMessage||images.reduce((sum,part)=>sum+(part.attachment?.bytes??0),0)>mediaPolicy.maxMessageBytes)return false;
  if(batch.messageId&&events.some(e=>e.type==='assistant/message'&&e.data.message.id===batch.messageId))return false;
  j.put(agent.id,'ownerBatch',{...batch,invalidated:true});j.set(agent.id,agent.desired().desired);
  j.audit(agent.id,'owner-input-supplemented',{batchId:batch.id,lane:'foreground',origin:'owner'});return true;
}
export function bindOwnerResponse(agent,batch,messageId){
  if(!batch)return;
  const j=agent.factory.journal,current=j.value(agent.id,'ownerBatch',null);
  if(!current||current.id!==batch.id||current.invalidated)throw new Error('STALE_OWNER_BATCH');
  j.put(agent.id,'ownerBatch',{...current,messageId});batch.messageId=messageId;
}
export function restoreOwnerBatch(agent,batch=agent.factory.journal.value(agent.id,'ownerBatch',null)){
  // The caller may still hold the pre-response batch object. The durable
  // checkpoint carries messageId once a native response has been prepared.
  const current=agent.factory.journal.value(agent.id,'ownerBatch',null);
  if(batch&&current?.id===batch.id)batch=current;
  if(!batch||batch.failed)return false;
  const events=agent.session.snapshotEvents();if(batch.messageId&&events.some(e=>e.type==='assistant/message'&&e.data.message.id===batch.messageId))return false;
  const map=new Map();for(const e of events){if(e.type==='user/message')map.set(e.data.id,e.data);if(e.type==='agent/inbox/spliced')for(const m of e.data.inserted??[])map.set(m.id,m);}
  const queued=new Set([...agent.inbox.nextTurn,...agent.inbox.nextStep].map(m=>m.id));
  const messages=batch.inputIds.map(id=>map.get(id)).filter(m=>m&&!queued.has(m.id)&&agent.factory.domain.sourceUsable(agent.id,m.id));
  if(messages.length)agent.inbox.splice(batch.target,0,0,messages);return !!messages.length;
}
export function finishOwnerBatch(agent,batch){
  if(!batch)return;const j=agent.factory.journal;if(j.value(agent.id,'ownerBatch',null)?.id===batch.id)j.put(agent.id,'ownerBatch',null);if(agent.ownerBatch?.id===batch.id)agent.ownerBatch=undefined;
}
export async function recoverOwnerBatch(agent){
  const batch=agent.factory.journal.value(agent.id,'ownerBatch',null);if(!batch)return;
  restoreOwnerBatch(agent,batch);await agent.flush();finishOwnerBatch(agent,batch);
}
