import {topicKeys,developmentInput} from './knowledge-signals.mjs';
import {researchUrl} from './learning.mjs';

const MODES=new Set(['adaptive','calm','warm','focused','playful']);
const labels={unknown:'未知',calm:'沉静',warm:'温暖陪伴',focused:'专注',playful:'轻松'};
const fail=code=>{throw new Error(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const validTtl=value=>Number.isSafeInteger(value)&&value>=5&&value<=1440;
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// The save path stamps the period on the server. Reads never renew it.
// Saving adaptive also starts a fresh observation period; old cues stay reset.
export function validateRoleSettings(input){
  if(!object(input)||Object.keys(input).some(key=>!['mode','ttlMinutes','reset'].includes(key))||!MODES.has(input.mode)||!validTtl(input.ttlMinutes)||input.reset!==undefined&&typeof input.reset!=='boolean')fail('INVALID_ROLE_SETTINGS');
  const now=Date.now();return {mode:input.reset===true?'adaptive':input.mode,ttlMinutes:input.ttlMinutes,configuredAt:now,resetAt:now};
}
function storedSettings(journal,id){
  const value=journal.value(id,'humanRoleSettings',{mode:'adaptive',ttlMinutes:120});
  if(!object(value)||!MODES.has(value.mode)||!validTtl(value.ttlMinutes))return {mode:'adaptive',ttlMinutes:120,configuredAt:null,resetAt:0,invalid:true};
  return {mode:value.mode,ttlMinutes:value.ttlMinutes,configuredAt:Number.isSafeInteger(value.configuredAt)&&value.configuredAt>=0?value.configuredAt:null,resetAt:Number.isSafeInteger(value.resetAt)&&value.resetAt>=0?value.resetAt:0};
}
const rules=[
  {id:'owner-reset-expression',mode:'unknown',phrases:['恢复默认语气','恢复自然语气','回到自然状态','不要设置相处模式','不用了','先不聊了','不用陪我','别陪我']},
  {id:'owner-calm-request',mode:'calm',phrases:['平静一点','安静一点','慢慢聊','别催我','先别开玩笑','不要开玩笑','用平静的语气']},
  {id:'owner-focused-request',mode:'focused',phrases:['认真一点','专注一点','直接说重点','先专心工作','用简洁的语气','先聊工作']},
  {id:'owner-warm-request',mode:'warm',phrases:['陪我聊聊','陪陪我','陪我说说话','温柔一点','用温柔的语气']},
  {id:'owner-playful-request',mode:'playful',phrases:['轻松一点','开个玩笑','逗我开心','讲个笑话','活泼一点','用轻松的语气']},
];
function cue(body){
  if(developmentInput(body)||/```|[“”"「」]|如果|假如|比如|例如|昨天|之前|上次|过去|她说|他说|有人说/u.test(body))return null;
  // Match only a complete direct request clause, not quoted, hypothetical,
  // negated, historical, or broad emotional vocabulary.
  const clauses=body.normalize('NFKC').split(/[,，。.！？!?；;\n]/u).map(value=>value.trim().replace(/^请/u,'').replace(/(?:吧|好吗|可以吗)$/u,'').trim());
  for(const clause of clauses.reverse())for(const rule of rules)if(rule.phrases.includes(clause))return rule;
  return null;
}
function unknown(ruleId,explanation,extra={}){return {mode:'unknown',label:labels.unknown,origin:'unknown',ruleId,sourceRefs:[],at:null,expires:null,explanation,...extra};}
function currentMode(journal,domain,id,settings,now){
  const ttl=settings.ttlMinutes*60000;
  if(settings.invalid)return unknown('invalid-stored-settings','短期角色配置不可用，等待主人重新保存。');
  if(settings.mode!=='adaptive'){
    const at=settings.configuredAt;
    if(at===null||at>now)return unknown('manual-period-unavailable','手动模式缺少有效的服务端起始时间，未启用。');
    if(at+ttl<=now)return unknown('manual-period-expired','主人设置的短期表达模式已到期，等待新设置。',{at,expires:at+ttl});
    return {mode:settings.mode,label:labels[settings.mode],origin:'manual-setting',ruleId:'owner-manual-'+settings.mode,sourceRefs:[],at,expires:at+ttl,explanation:'主人明确设置的短期表达方式；不表示角色或主人的真实情绪。'};
  }
  if(!table(journal.db,'source_record'))return unknown('owner-sources-unavailable','尚无可读取的主人来源。');
  const barrier=journal.value(id,'memoryContextBarrierAt',0),since=Math.max(now-ttl,Number.isSafeInteger(barrier)?barrier:0,settings.resetAt);
  const rows=journal.db.prepare("SELECT id,body,occurred FROM source_record WHERE agent=? AND kind='user' AND namespace='real' AND root=id AND status='active' AND occurred>? AND occurred<=? ORDER BY occurred DESC,id DESC LIMIT 32").all(id,since,now);
  for(const row of rows){if(!domain.sourceUsable(id,row.id)||domain.sourceIsDevelopmentTest?.(id,row.id))continue;const rule=cue(row.body);if(!rule)continue;
    return {mode:rule.mode,label:labels[rule.mode],origin:'owner-explicit-cue',ruleId:rule.id,sourceRefs:[row.id],at:row.occurred,expires:row.occurred+ttl,explanation:rule.mode==='unknown'?'主人明确要求复位表达方式；未推断新的相处模式。':'最近有效主人原话中的明确表达请求匹配了固定规则；不推断主人的情绪、身体状态或长期偏好。'};
  }
  return unknown('no-current-explicit-cue','当前有效来源中没有匹配到明确的表达请求，保持未知。');
}
function interests(journal,domain,id,now){
  const db=journal.db,windowMs=30*86400000;
  if(!['learning_note','memory_record','source_record'].every(name=>table(db,name)))return {items:[],windowMs,scannedNotes:0,validNotes:0,partial:false};
  const barrier=journal.value(id,'memoryContextBarrierAt',0),since=Math.max(now-windowMs,Number.isSafeInteger(barrier)?barrier:0);
  const rows=db.prepare("SELECT n.id,n.data,n.created,n.source_id,m.refs FROM learning_note n JOIN memory_record m ON m.id=n.memory_id AND m.agent=n.agent JOIN source_record s ON s.id=n.source_id AND s.agent=n.agent WHERE n.agent=? AND n.status='active' AND m.status='active' AND m.namespace='real' AND m.valid_from<=? AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active' AND s.namespace='real' AND n.created>? AND n.created<=? ORDER BY n.created DESC,n.id DESC LIMIT 201").all(id,now,now,since,now);
  const groups=new Map();let validNotes=0;
  for(const row of rows.slice(0,200)){
    const data=parse(row.data),refs=parse(row.refs);if(!data||!Array.isArray(refs)||!refs.includes(row.source_id)||!refs.length||!refs.every(ref=>typeof ref==='string'&&domain.sourceUsable(id,ref)&&db.prepare("SELECT 1 FROM source_record WHERE agent=? AND id=? AND status='active' AND namespace='real'").get(id,ref))||!Array.isArray(data.claims)||!data.claims.length||!data.claims.every(claim=>typeof claim?.text==='string'&&claim.text.trim()&&typeof claim.quote==='string'&&claim.quote.length>=8)||!data.source?.url||!data.source?.digest||developmentInput(data.researchQuestion??''))continue;
    try{researchUrl(data.source.url);}catch{continue;}
    validNotes++;const keys=topicKeys([data.title,data.researchQuestion,data.summary].filter(value=>typeof value==='string').join(' '));
    for(const key of keys.length?keys:['其他已学习资料']){if(!groups.has(key))groups.set(key,{key,label:key,noteCount:0,lastLearnedAt:row.created,noteIds:[],sourceRefs:[],method:'bounded-topic-word-rules',ownerPreference:false});const group=groups.get(key);group.noteCount++;group.lastLearnedAt=Math.max(group.lastLearnedAt,row.created);if(group.noteIds.length<4)group.noteIds.push(row.id);for(const ref of refs)if(group.sourceRefs.length<4&&!group.sourceRefs.includes(ref))group.sourceRefs.push(ref);}
  }
  return {items:[...groups.values()].sort((a,b)=>b.noteCount-a.noteCount||b.lastLearnedAt-a.lastLearnedAt||a.key.localeCompare(b.key)).slice(0,6),windowMs,scannedNotes:Math.min(rows.length,200),validNotes,partial:rows.length>200,countsCanOverlap:true};
}
export function roleState(journal,domain,id,{now=Date.now()}={}){
  journal.assertAdmitted(id);if(!Number.isSafeInteger(now)||now<0)fail('INVALID_ROLE_TIME');
  const settings=storedSettings(journal,id),current=currentMode(journal,domain,id,settings,now),learning=interests(journal,domain,id,now);
  return {version:1,at:now,settings,current,interests:learning.items,learning:{...learning,items:undefined},policy:{stableCoreChanged:false,ownerFactsWritten:false,modelCalls:0,semanticInference:false,description:'短期表达方式来自主人手动设置或明确原话规则；学习投入只统计近30天有效笔记主题，不表示主人偏好、真实情绪或七天人格进化。'}};
}
