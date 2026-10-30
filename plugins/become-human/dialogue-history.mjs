import {developmentInput} from './knowledge-signals.mjs';
import {agentExperienceRisk,careKnowledgeRisk,ownerAttributionRisk} from './learning.mjs';
import {replyPressureRisk,outboundReplyRoleRisk} from './social.mjs';

const textOf=message=>(message?.content??[]).filter(part=>part.type==='text').map(part=>part.text??'').join('');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const ids=value=>Array.isArray(value)&&value.length<=16&&new Set(value).size===value.length&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=160);
const originCache=new WeakMap();
const excerpt=text=>{const chars=Array.from(text);return chars.length<=4096?{text,historyExcerpt:false}:{text:chars.slice(0,2048).join('')+'\n[中间内容未装入；这是历史摘录]\n'+chars.slice(-2048).join(''),historyExcerpt:true};};

export function dialogueAssistantAllowed(agent,event){
  const j=agent.factory.journal,id=agent.id,message=event.data.message,body=textOf(message);
  if(agentExperienceRisk(body)||replyPressureRisk(body))return false;
  if(outboundReplyRoleRisk(body)&&j.value(id,'socialContacts',[]).some(row=>row.messageId===message.id&&['chat','care'].includes(row.kind)))return false;
  const workRefs=j.value(id,'work-observation-message:'+message.id,null);
  if(workRefs?.length&&!workRefs.every(ref=>{const row=agent.factory.workObservation?.get(id,ref.id);return row?.valid===true&&row.version===ref.version;}))return false;
  const noteId=j.value(id,'learning-message:'+message.id,null);
  if(!noteId)return !careKnowledgeRisk(body);
  if(ownerAttributionRisk(body))return false;
  if(typeof agent.factory.autonomy?.note==='function'){
    const note=agent.factory.autonomy.note(id,noteId);
    return !!note&&note.status==='active'&&note.sourceValid!==false;
  }
  return !!j.db?.prepare("SELECT 1 FROM learning_note n JOIN memory_record m ON m.id=n.memory_id WHERE n.id=? AND n.status='active' AND m.status='active'").get(noteId);
}

// Bind a reply to its durable admitted input, never to a nearby timestamp or
// merely the last user bubble. Old installs have the same binding in audits.
function publishedOrigins(journal,agent){
  const db=journal.db;
  if(!db?.prepare)return new Map();
  try{
    const latest=db.prepare("SELECT max(seq) AS seq FROM audit WHERE agent=? AND kind='response-published'").get(agent)?.seq??0;
    const previous=originCache.get(db);
    if(previous?.agent===agent&&previous.seq===latest)return previous.origins;
    const origins=new Map();
    for(const row of db.prepare("SELECT data FROM audit WHERE agent=? AND kind='response-published' ORDER BY seq DESC LIMIT 2048").all(agent)){
      const record=parse(row.data);if(!record?.messageId||origins.has(record.messageId))continue;
      let request;
      if(record.attemptId){const attempt=db.prepare('SELECT request FROM attempt WHERE agent=? AND id=?').get(agent,record.attemptId);request=attempt&&parse(attempt.request);}
      if(ids(request?.admittedIds)&&request.admittedIds.length)origins.set(record.messageId,{inputIds:request.admittedIds,lane:'foreground'});
      else if(record.origin==='timer'&&(!request?.admittedIds?.length))origins.set(record.messageId,{inputIds:[],lane:'autonomous'});
    }
    originCache.set(db,{agent,seq:latest,origins});return origins;
  }catch{return new Map();}
}

/** Bounded, complete conversation turns. Does not extract facts or mutate memory. */
export function recentDialogue(agent,{lane='executor',admittedIds=[],assistantAllowed=()=>true,turnLimit,scopePolicy='current'}={}){
  const {journal,domain}=agent.factory,id=agent.id,events=agent.session.snapshotEvents();
  const barrier=journal.value(id,'memoryContextBarrierAt',0),owners=new Map(),assistants=[],runs=new Map();
  let run='initial',serial=0;
  for(let index=0;index<events.length;index++){
    const event=events[index];
    if(event.type==='turn/start'){run='native:'+String(event.data.turn)+':'+String(event.seq??index);runs.set(run,{owners:[],assistants:[],ended:null});}
    if(event.type==='turn/end'&&runs.has(run))runs.get(run).ended=event.data.reason?.kind??null;
    if(event.type==='user/message'){
      const body=textOf(event.data),row={event,index,run,id:event.data.id,text:body,developmentOnly:domain.sourceIsDevelopmentTest?.(id,event.data.id)===true||developmentInput(body)};
      owners.set(row.id,row);runs.get(run)?.owners.push(row.id);
    }
    if(event.type==='assistant/message'){
      const row={event,index,run,id:event.data.message.id,text:textOf(event.data.message)};assistants.push(row);runs.get(run)?.assistants.push(row.id);
    }
  }
  const admitted=new Set(admittedIds),foreground=lane==='foreground',currentOwners=admittedIds.length?admittedIds.map(key=>owners.get(key)).filter(Boolean):foreground?[...owners.values()].slice(-1):[];
  const developmentOnly=foreground&&currentOwners.some(row=>row.developmentOnly);
  const currentIndex=currentOwners.length?Math.min(...currentOwners.map(row=>row.index)):events.length;
  // Development dialogue is local to the current uninterrupted fixture segment.
  // A normal owner turn closes it; neither its input nor its replies leak back.
  const boundary=developmentOnly?Math.max(-1,...[...owners.values()].filter(row=>row.index<currentIndex&&!row.developmentOnly).map(row=>row.index)):-1;
  const usable=row=>!!row&&row.event.time>barrier&&domain.sourceUsable(id,row.id);
  const adjacent=foreground&&scopePolicy==='adjacent';
  const allowed=(sourceRows,dev)=>sourceRows.every(usable)&&(adjacent|| (developmentOnly?dev&&sourceRows.every(row=>row.index>boundary):!dev));
  const origins=publishedOrigins(journal,id),associated=new Set(),groups=[];
  const ownerRow=(row,group,dev)=>({role:'user',id:row.id,...excerpt(row.text),time:row.event.time,dialogueTurnId:group,developmentOnly:dev});
  const lastPrior=adjacent?assistants.filter(row=>row.index<currentIndex).at(-1):null;
  const scannedAssistants=adjacent?(lastPrior?[lastPrior]:[]):assistants.slice(-256),scanBoundary=assistants.length>256&&!adjacent?scannedAssistants[0].index:-1;
  for(const assistant of scannedAssistants){
    let origin=journal.value(id,'dialogue-origin:'+assistant.id,null);
    if(!origin||!ids(origin.inputIds)||!['foreground','autonomous'].includes(origin.lane))origin=null;
    const local=journal.value(id,'local-admitted:'+assistant.id,null);
    if(!origin&&ids(local)&&local.length)origin={inputIds:local,lane:'foreground'};
    origin??=origins.get(assistant.id);
    if(!origin){
      // Conservative legacy fallback: same concrete native run, completed, one
      // reply, all preceding owner events. Repeated turn numbers are not joined.
      const native=runs.get(assistant.run),sourceRows=native?.owners.map(key=>owners.get(key));
      if(native?.ended==='completed'&&native.assistants.length===1&&sourceRows?.length&&sourceRows.every(row=>row.index<assistant.index))origin={inputIds:native.owners,lane:'foreground'};
    }
    if(!origin)continue;
    const sourceRows=origin.inputIds.map(key=>owners.get(key));
    for(const key of origin.inputIds)associated.add(key);
    const dev=sourceRows.some(row=>row?.developmentOnly===true);
    if(assistant.event.time<=barrier||!dialogueAssistantAllowed(agent,assistant.event)||!assistantAllowed(assistant.event))continue;
    if(adjacent){
      const published=journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND kind='assistant' AND event_key=?").get(id,'assistant:'+assistant.id);
      if(!published||published.text!==assistant.text)continue;
    }
    if(origin.lane==='foreground'){
      if(!sourceRows.length||sourceRows.some(row=>!row||row.index>=assistant.index)||!allowed(sourceRows,dev)||sourceRows.some(row=>admitted.has(row.id)))continue;
    }else if(origin.inputIds.length||!adjacent&&developmentOnly||developmentInput(assistant.text))continue;
    const group='reply:'+assistant.id;
    const modelSource=assistant.event.data.message.source;
    const source=modelSource&&typeof modelSource.provider==='string'&&typeof modelSource.model==='string'?{kind:'model',provider:modelSource.provider,model:modelSource.model}:undefined;
    groups.push({index:assistant.index,rows:[...sourceRows.map(row=>ownerRow(row,group,dev)),{role:'assistant',id:assistant.id,...excerpt(assistant.text),...(source?{source}:{}),time:assistant.event.time,dialogueTurnId:group,developmentOnly:dev,...(!sourceRows.length?{autonomous:true}:{})}]});
  }
  // Valid unanswered owner turns can still supply dialogue context, but never
  // turn a revoked/unknown response's surviving bubbles into a different turn.
  const pending=new Map();
  for(const row of owners.values())if(!adjacent&&row.index>scanBoundary&&!associated.has(row.id)&&!admitted.has(row.id)){
    const rows=pending.get(row.run)??[];rows.push(row);pending.set(row.run,rows);
  }
  for(const sourceRows of pending.values()){
    const dev=sourceRows.some(row=>row.developmentOnly);if(!allowed(sourceRows,dev))continue;
    const group='owner:'+String(++serial)+':'+sourceRows[0].id;groups.push({index:sourceRows.at(-1).index,rows:sourceRows.map(row=>ownerRow(row,group,dev))});
  }
  const configured=agent.factory.management?.execution(id).context?.historyLimit??journal.value(id,'humanExecution',{}).context?.historyLimit??8;
  const limit=Number.isInteger(turnLimit)?Math.max(1,Math.min(256,turnLimit)):Number.isInteger(configured)?Math.max(1,Math.min(40,configured)):8;
  const rows=groups.sort((a,b)=>a.index-b.index).slice(-limit).flatMap(group=>group.rows);
  Object.defineProperty(rows,'coverage',{value:{scanTurnLimit:256,olderNativeRepliesOutsideScan:Math.max(0,assistants.length-256),eligibleTurnCount:groups.length,selectedTurnCount:Math.min(limit,groups.length)},enumerable:false});
  return rows;
}

// A factual record of what was just said, not a new memory or a scope switch.
// Never substitute an older turn if the actual latest reply is unavailable,
// withdrawn, unpublished or no longer allowed by its original provenance.
export function adjacentDialogue(agent,{admittedIds=[]}={}){
  try{return recentDialogue(agent,{lane:'foreground',admittedIds,turnLimit:1,scopePolicy:'adjacent'}).map(row=>({...row,adjacentReferenceOnly:true}));}catch{return [];}
}
