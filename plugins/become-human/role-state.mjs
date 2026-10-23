import {topicKeys,developmentInput} from './knowledge-signals.mjs';
import {researchUrl} from './learning.mjs';

const fail=code=>{throw new Error(code);};
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// Older clients may still send this operation during an upgrade. It cannot
// restore the removed manual or keyword-triggered expression mode.
export function validateRoleSettings(){fail('EXPRESSION_MODE_REMOVED');}
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
  const learning=interests(journal,domain,id,now);
  return {version:2,at:now,interests:learning.items,learning:{...learning,items:undefined},policy:{stableCoreChanged:false,ownerFactsWritten:false,expressionModeRemoved:true,modelCalls:0,semanticInference:false,description:'学习投入只统计近30天有效笔记主题；人格成长另由有证据、可回滚的人格偏移记录管理，不根据固定表达模式或关键词设定人的情绪。'}};
}
