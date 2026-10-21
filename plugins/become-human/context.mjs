import {createHash} from 'node:crypto';
import {roleState} from './role-state.mjs';

export const contextDefaults=Object.freeze({memoryLimit:8,historyLimit:8,learningLimit:3,selectionInputBudget:12288,executorInputBudget:32768,foregroundInputBudget:49152});
export const personaPolicy='当前身份、关系和基础兴趣只以 persona.core 与 persona.profile 为准。persona.tendencies、temporary 和有效反馈在当前设定范围内调整表达。先结合当前人物，再核对有效记忆、反馈、目标与近期话题，最后选择值得思考、学习或交流的方向；无需固定选择某种兴趣。历史角色、旧选题、资料与 Skill 不得充当另一份人物设定。人物兴趣不等于主人偏好；学习主题不等于已确认的长期性格变化。';
export const contextPolicy='当前状态来自本轮可用记录，不代表人的实时感受。历史原话只在所标时间成立；情绪、身体状态和现实处境现在是否仍成立，必须询问确认。记忆的 truth=inferred 是推断，不是主人确认；summaryKind=excerpt 或 evidence-excerpts 是来源摘录，不是完整语义摘要。eventOverviews 仅将有证据的历史交流按时段与词面话题归组，topicHints 不代表确认偏好；temporalValidity 不代表现实状况已核实，possible-conflict 须核对原证据及时间。未装入的资料不等于不存在，不能声称读过。';
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pack=(system,data)=>[{role:'system',content:[{type:'text',text:system}]},{role:'user',content:[{type:'text',text:JSON.stringify(data)}]}];
const get=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
const set=(o,path,value)=>{const keys=path.split('.');let target=o;for(const k of keys.slice(0,-1))target=target[k]??={};target[keys.at(-1)]=value;};
const clip=(text,max)=>{const chars=Array.from(String(text??''));return chars.length>max?chars.slice(0,max).join('')+'…':chars.join('');};
export const contextSettings=(journal,id)=>({...contextDefaults,...journal.value(id,'humanExecution',{}).context});

// A recalled memory ID is not a user statement ID. Only real, direct owner
// sources that are actually present in this request can support attribution.
export function ownerSourceUsable(agent,sourceId){
  const {journal,domain}=agent.factory;
  const source=journal.db.prepare("SELECT root FROM source_record WHERE id=? AND agent=? AND status='active' AND namespace='real' AND kind='user'").get(sourceId,agent.id);
  return !!source&&source.root===sourceId&&domain.sourceUsable(agent.id,sourceId)&&!domain.sourceIsDevelopmentTest?.(agent.id,sourceId);
}
export function requestOwnerSourceIds(agent,data){
  const ids=new Set((data.ownerEvidence??[]).map(e=>e.id));
  for(const item of [...(data.recent??[]),...(data.history??[])])if(item.role==='user')ids.add(item.id);
  for(const memory of data.domain?.memories??[])if(memory.truth==='factual'&&['fact','episode','identity','working'].includes(memory.type))for(const ref of memory.refs??[])ids.add(ref);
  for(const overview of data.domain?.eventOverviews??[])for(const ref of overview.sourceIds??[])ids.add(ref);
  return [...ids].filter(id=>typeof id==='string'&&ownerSourceUsable(agent,id));
}

// Rebuilt from live records for every request. No persisted prose summary can
// outlive a correction, expiry or deletion of its underlying memories.
export function situation(agent,task,now=Date.now()){
  const {journal:j,autonomy:store,domain}=agent.factory,id=agent.id,s=store.settings(id);
  const users=agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&domain.sourceUsable(id,e.data.id));
  const last=users.at(-1),pending=j.db.prepare("SELECT id,kind,status,updated FROM autonomy_task WHERE agent=? AND status IN ('ready','suspended','waiting-budget','executing') ORDER BY created,id LIMIT 4").all(id);
  const reminders=j.db.prepare("SELECT id,status,due_at FROM reminder WHERE agent=? AND status IN ('pending','staged','paused','blocked') ORDER BY due_at,id LIMIT 4").all(id);
  const local=new Date(now+s.timeZoneOffsetMinutes*60000).toISOString().slice(0,19).replace('T',' ');
  const actions=agent.factory.actions?.list(id).filter(a=>a.sourceValid).slice(0,3).map(a=>({id:a.id,title:clip(a.title,100),status:a.status,hasReceipt:!!a.receipt}))??[];
  return {actions,at:now,localTime:local,timeZoneOffsetMinutes:s.timeZoneOffsetMinutes,owner:{lastMessage:last?{id:last.data.id,at:last.time,ageMinutes:Math.max(0,Math.floor((now-last.time)/60000))}:null,currentMood:'unknown'},contact:{quiet:store.quiet(s,now),lastContact:j.value(id,'lastAutonomousContact',null),minimumGapMs:s.contactCooldownMs},currentTask:task?{id:task.id,kind:task.kind,status:task.status,hasPlan:!!task.checkpoint.plan,noteId:task.checkpoint.noteId??null,hasSource:!!task.checkpoint.source}:null,pendingTasks:pending.filter(t=>t.id!==task?.id).slice(0,3),pendingTaskCount:j.db.prepare("SELECT count(*) AS n FROM autonomy_task WHERE agent=? AND status IN ('ready','suspended','waiting-budget','executing')").get(id).n,reminders,reminderCount:j.db.prepare("SELECT count(*) AS n FROM reminder WHERE agent=? AND status IN ('pending','staged','paused','blocked')").get(id).n,authorization:{awaitingExtraBudget:!!j.value(id,'autonomyBudgetRequest',null),autonomyPaused:j.value(id,'autonomyPaused',false),waitReason:j.value(id,'autonomyWait',null)},lastResearch:j.value(id,'recentResearch',[]).slice(-2).map(r=>({question:clip(r.question??r.query,120),at:r.time??r.searchedAt??null,status:r.status??null}))};
}

function compactPersona(persona){
  if(!persona)return persona;
  const {profile,...rest}=persona;
  if(!profile)return rest;
  const {corePrompt,...fields}=profile;
  return {...rest,profile:fields};
}

// The byte estimate includes the actual serialized messages and a framing
// allowance. It is a deliberately conservative admission unit, not a tokenizer
// result. Fixed instructions, current input and source evidence are never cut.
export function contextMessages(agent,lane,system,data,task){
  const j=agent.factory.journal,id=agent.id,settings=contextSettings(j,id),selection=lane==='selection';
  const budget=settings[selection?'selectionInputBudget':lane==='foreground'?'foregroundInputBudget':'executorInputBudget'];
  const now=Date.now(),query=[task?.checkpoint.plan?.question,task?.checkpoint.candidate?.question,...(data.input??[]).map(m=>m.content?.filter(c=>c.type==='text').map(c=>c.text).join(''))].filter(Boolean).join(' ').slice(0,1000);
  const result=structuredClone(data),evidenceIds=new Set((result.ownerEvidence??[]).map(m=>m.id)),inputIds=new Set((result.input??[]).map(m=>m.id));
  const ownerScoped=lane==='executor'&&['care','chat'].includes(task?.kind);
  const sourceTask=lane==='executor'&&!!result.source;
  const packed=()=>{if(ownerScoped)result.eligibleOwnerSourceIds=requestOwnerSourceIds(agent,result);return pack(system+personaPolicy+contextPolicy,result);};
  result.persona=compactPersona(result.persona);
  // Detailed source analysis needs the chosen question and public evidence,
  // not personal dialogue. Personalization belongs to direction selection or
  // the separate owner-facing conversation/share stage.
  if(sourceTask){result.ownerEvidence=[];result.recent=[];if(result.persona?.profile)for(const field of ['ownerName','ownerCity','ownerPreferences'])delete result.persona.profile[field];}
  result.situation=situation(agent,task,now);if(sourceTask)result.situation.actions=[];
  if(sourceTask)delete result.roleState;
  else{
    const role=roleState(j,agent.factory.domain,id,{now});
    result.roleState={current:{mode:role.current.mode,label:role.current.label,explanation:clip(role.current.explanation,180),expires:role.current.expires},interests:role.interests.slice(0,3).map(item=>({label:clip(item.label,80),origin:'valid-learning-note-titles',ownerPreference:false})),scope:'Rule-derived interaction mode and observed learning themes; not proof of emotions, owner preferences or long-term personality growth.'};
  }
  if(selection&&result.ownerEvidence)result.ownerEvidence=result.ownerEvidence.slice(-2).map(m=>({...m,text:clip(m.text,200),summaryKind:'excerpt',currentState:'unconfirmed'}));
  if(result.history)result.history=result.history.filter(m=>!inputIds.has(m.id));
  if(result.recent)result.recent=result.recent.filter(m=>!evidenceIds.has(m.id));
  const excluded=new Set([...inputIds,...(result.ownerEvidence??[]).map(m=>m.id),...(result.history??[]).filter(m=>m.role==='user').map(m=>m.id),...(result.recent??[]).filter(m=>m.role==='user').map(m=>m.id)]);
  const recalled=agent.factory.domain.context(id,{query:query||data.task?.instruction?.slice(0,1000)||'',includePersona:false,excludeEpisodeRefs:[...excluded],excludeTypes:ownerScoped?['skill']:sourceTask?['episode','fact','identity','working']:[]});
  // Always use one canonical memory block. Avoid sending the same persona in it.
  delete result.memories;
  result.domain=recalled;
  result.domain.eventOverviews=sourceTask?[]:agent.factory.domain.eventOverviews?.(id,{query,limit:selection?2:3,excludeRefs:[...excluded]})??[];
  if(agent.factory.goals){const progress=agent.factory.goals.context(id,{limit:3,chars:1400});result.domain.goals=result.domain.goals.map(g=>({...g,...(progress.find(p=>p.id===g.id)??{})}));}
  if(selection){delete result.clock;delete result.recentResearch;}
  // A completed note already contains these conclusions. Retain unrelated
  // retrieved knowledge instead of repeating the same note as a skill memory.
  if(task?.checkpoint.noteId){const n=agent.factory.autonomy.note(id,task.checkpoint.noteId);if(n)result.domain.memories=result.domain.memories.filter(m=>m.id!==n.memory_id);}
  result.domain.memories=result.domain.memories.map(m=>m.type==='episode'&&typeof m.payload.userSaid==='string'?{...m,payload:{userSaid:clip(m.payload.userSaid,selection?180:500)},summaryKind:'excerpt',currentState:'unconfirmed'}:m);
  const optional=['situation.actions','domain.memories','domain.goals','ownerEvidence','history','recent','learningNotes','domain.eventOverviews',...(!sourceTask?['roleState.interests']:[]),...(result.social?['social.topicMemory.topics','social.recentTopics']:[])];
  const inputBytes=bytes(packed())+256;
  const candidates=new Map(optional.map(path=>[path,get(result,path)??[]]));
  for(const path of optional)set(result,path,[]);
  const base=packed(),required=bytes(base)+256;
  if(required>budget){const context={lane,budget,required,estimate:'utf8-bytes-plus-framing'};j.audit(id,'context-input-blocked',{...context,taskId:task?.id,code:'CONTEXT_BUDGET_TOO_SMALL',type:'model'});throw Object.assign(new Error('CONTEXT_BUDGET_TOO_SMALL'),{context});}
  const counts={},omitted={};
  // First reserve one important long-term fact and one active goal, then the
  // newest owner evidence, then fill remaining slots in relevance order.
  const picked=new Map(optional.map(path=>[path,new Set()]));
  const add=(path,index)=>{const rows=candidates.get(path),row=rows[index];if(!row||picked.get(path).has(index))return;
    picked.get(path).add(index);set(result,path,rows.filter((_,i)=>picked.get(path).has(i)));
    if(bytes(packed())+256>budget){picked.get(path).delete(index);set(result,path,rows.filter((_,i)=>picked.get(path).has(i)));}
  };
  const stable=candidates.get('domain.memories').findIndex(m=>['identity','fact'].includes(m.type));
  if(stable>=0)add('domain.memories',stable);add('domain.goals',0);
  const evidence=candidates.get('ownerEvidence');if(evidence.length)add('ownerEvidence',evidence.length-1);
  for(const path of optional){const rows=candidates.get(path),indices=rows.map((_,i)=>i);if(['history','recent','ownerEvidence'].includes(path))indices.reverse();for(const i of indices)add(path,i);counts[path]=picked.get(path).size;omitted[path]=rows.length-counts[path];}
  // Stable source IDs + versions identify the actual basis without saving
  // another copy of memory text. This is a record, not an extra model call.
  const refs=result.domain.memories.map(m=>({id:m.id,version:m.version}));
  const output=packed(),estimatedInput=bytes(output)+256;
  const report={version:1,lane,time:now,budget,estimatedInput,required,inputBytes,estimate:'utf8-bytes-plus-framing',counts,omitted,importantFactsOmitted:candidates.get('domain.memories').filter((m,i)=>['identity','fact'].includes(m.type)&&!picked.get('domain.memories').has(i)).length,basis:hash({persona:result.persona?.version,refs,goals:result.domain.goals,situation:result.situation}),memoryRefs:refs};
  Object.defineProperty(output,'contextReport',{value:report,enumerable:false});
  if(ownerScoped)Object.defineProperty(output,'ownerSourceIds',{value:result.eligibleOwnerSourceIds,enumerable:false});
  return output;
}

export function recordContext(agent,messages,{taskId,turn,lane}={}){
  const report=messages.contextReport;if(!report)return;
  const j=agent.factory.journal;
  j.put(agent.id,'contextLast:'+lane,report);
  j.audit(agent.id,'context-assembled',{...report,taskId,turn,type:'model'});
}
