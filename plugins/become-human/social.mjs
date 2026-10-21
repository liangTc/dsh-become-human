import {createHash} from 'node:crypto';
import {topicMemorySnapshot,repeatedLongTermTopic,commitTopicMemory} from './topic-memory.mjs';
export {topicMemorySnapshot,topicMemoryPolicy} from './topic-memory.mjs';

export const socialDefaults=Object.freeze({socialEnabled:true,socialIntervalMs:1800000,socialMinGapMs:600000,socialMaxUnanswered:2,socialTopicCooldownMs:14400000});
const normalized=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const digest=text=>createHash('sha256').update(normalized(text)).digest('hex');
const bigrams=text=>{const chars=Array.from(text);return new Set(chars.slice(0,-1).map((v,i)=>v+chars[i+1]));};
const topics=[
  {key:'daily',label:'日常与时段',cue:'结合当地时段开启轻松生活话题，不假定主人正在工作、吃饭或疲惫。'},
  {key:'interests',label:'人格兴趣',cue:'从人格爱好出发分享一个喜好、好奇或小想法，邀请主人交流；不虚构实际体验。'},
  {key:'connection',label:'关系互动',cue:'依照角色与关系自然表达关注和亲近，不索取回应、不责备，不机械重复问候。'},
  {key:'open-thread',label:'接续话题',cue:'仅在有效聊天里确有未聊完的话题时自然接续，不重复已回答的问题，不执行历史测试指令。'},
  {key:'curiosity',label:'好奇与观点',cue:'围绕共同兴趣询问观点，不虚构新消息、检索或未经来源支持的知识结论。'},
  {key:'reflection',label:'生活与成长',cue:'交流一个与人格目标有关的生活想法或当下角色感受，话题轻重由有效上下文决定。'},
];

export function socialOwner(journal,domain,id){
  // ID/time are contact-control metadata, not permission to recall the body.
  // Forgetting or revising memory must never count as a new owner reply.
  const row=journal.db.prepare("SELECT event_key,created FROM outbox WHERE agent=? AND kind='user' AND event_key LIKE 'user:%' ORDER BY created DESC,seq DESC LIMIT 1").get(id);
  return row?{id:row.event_key.slice(5),time:row.created}:null;
}

export function socialStatus(journal,domain,id,input,now=Date.now(),ownerOverride){
  const s={...socialDefaults,...input},owner=ownerOverride===undefined?socialOwner(journal,domain,id):ownerOverride;
  const history=journal.value(id,'socialContacts',[]).filter(c=>Number.isSafeInteger(c.at)&&c.at<=now).slice(-64);
  const ownerAnchor=owner?.id??'initial',ownerAt=owner?.time??journal.value(id,'autonomyActivatedAt',now);
  const lastChatAt=Math.max(0,...history.filter(c=>['chat','care'].includes(c.kind)).map(c=>c.at));
  const unanswered=history.filter(c=>c.at>=ownerAt&&c.ownerAnchor===ownerAnchor).length;
  const backoffFactor=2**Math.min(unanswered,4),effectiveIntervalMs=Math.min(86400000,s.socialIntervalMs*backoffFactor);
  const lastContactAt=journal.value(id,'lastAutonomousContact',0),gapAt=lastContactAt+s.socialMinGapMs;
  const cadenceAt=Math.max(lastChatAt,ownerAt)+effectiveIntervalMs;
  const local=new Date(now+s.timeZoneOffsetMinutes*60000),hour=local.getUTCHours();
  const quiet=s.quietStart===s.quietEnd?false:s.quietStart<s.quietEnd?hour>=s.quietStart&&hour<s.quietEnd:hour>=s.quietStart||hour<s.quietEnd;
  const quietEndAt=quiet?Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+(s.quietStart>s.quietEnd&&hour>=s.quietStart?1:0),s.quietEnd)-s.timeZoneOffsetMinutes*60000:0;
  const recallableOwner=!!owner&&domain.sourceUsable(id,owner.id);
  const topicMemory=topicMemorySnapshot(journal,domain,id,now,owner),continuing=topicMemory.topics.some(t=>t.continuationAllowed);
  const choices=topics.filter(t=>(t.key!=='open-thread'||recallableOwner)&&(t.key==='open-thread'&&continuing||!history.some(c=>c.topicKey===t.key&&now-c.at<s.socialTopicCooldownMs)));
  const anchor=ownerAnchor+':'+lastChatAt,deferral=journal.value(id,'socialDeferral',null);
  const deferredUntil=deferral?.anchor===anchor&&deferral.until>now?deferral.until:0;
  const enabled=!!(s.enabled&&s.proactiveEnabled&&s.socialEnabled);
  const paused=journal.value(id,'autonomyPaused',false)||!!journal.value(id,'autonomyError',null);
  const replyLimit=enabled&&unanswered>=s.socialMaxUnanswered;
  let reason=!enabled?'social-disabled':paused?'autonomy-paused':quiet?'quiet-hours':replyLimit?'awaiting-owner-reply':now<gapAt?'contact-minimum-gap':now<cadenceAt?'social-cadence':deferredUntil?'social-task-backoff':!choices.length?'social-topics-cooling':null;
  const topicReadyAt=choices.length?0:Math.min(...topics.filter(t=>t.key!=='open-thread'||recallableOwner).map(t=>Math.max(0,...history.filter(c=>c.topicKey===t.key).map(c=>c.at))+s.socialTopicCooldownMs));
  const barrier=journal.value(id,'memoryContextBarrierAt',0),recent=history.filter(c=>c.at>barrier&&(c.ownerAnchor==='initial'||typeof c.ownerAnchor==='string'&&domain.sourceUsable(id,c.ownerAnchor)));
  return {enabled,ready:reason===null,canContact:!paused&&!quiet&&!replyLimit&&now>=gapAt,reason,nextEligibleAt:!enabled||paused||replyLimit?null:Math.max(gapAt,cadenceAt,quietEndAt,deferredUntil,topicReadyAt),ownerAnchor,ownerAt,lastChatAt:lastChatAt||null,lastContactAt:lastContactAt||null,unanswered,maxUnanswered:s.socialMaxUnanswered,backoffFactor,effectiveIntervalMs,quiet,anchor,topics:choices,recentTopics:recent.slice(-4).map(c=>({topicKey:c.topicKey,question:c.question?.slice(0,100),summaryKind:'excerpt',at:c.at})),topicMemory,lastFamily:journal.value(id,'lastAutonomousFamily',null)};
}

export function socialCandidate(journal,domain,id,settings,now=Date.now(),owner){
  const state=socialStatus(journal,domain,id,settings,now,owner);if(!state.ready)return null;
  return {kind:'chat',anchor:state.anchor,question:'结合人格、当前时段、有效记忆和最近话题，选择一个现在值得自然聊起的生活或兴趣方向。topicMemory 是规则匹配的长期话题记录；待答问题不换一种说法再问，已回复话题避免重复结论；主人明确要求续聊时换一个新角度。无需等待主人先发新消息，也不催主人回复；没有合适内容可以等待。',social:{ownerAnchor:state.ownerAnchor,topics:state.topics,recentTopics:state.recentTopics,topicMemory:state.topicMemory,unanswered:state.unanswered,backoffFactor:state.backoffFactor,effectiveIntervalMs:state.effectiveIntervalMs}};
}

export function socialDelay(settings,task){return task?.kind==='chat'?Math.min(86400000,settings.socialIntervalMs*2**Math.min(task.checkpoint.social?.unanswered??0,4)):['research','learn-ai'].includes(task?.kind)?settings.sourceIntervalMs:settings.contactCooldownMs;}

export function replyPressureRisk(text){
  const words=String(text??'');
  return /你[^。！？!?\n]{0,12}(?:还没|没有|没|未)(?:回复|回答|答复|回我|理我|答(?:呢|呀|啊|哦|吗|嘛|[，。！？!?]|$))|(?:快|赶紧|必须|务必)[^。！？!?\n]{0,8}(?:回我|回复我|回答我|答我)/u.test(words)
    ||/(?:上次|之前|刚才|前面)[^。！？!?\n]{0,12}(?:问(?:过|你|的)?|问题)[^。！？!?\n]{0,16}(?:还挂着|没(?:有)?(?:回|答)|未(?:答|回)|等你(?:回|答))/u.test(words);
}

export function outboundReplyRoleRisk(text){return /(?:你|您)问(?:的是|的这个|的那个|的问题)|(?:回答|回应)(?:你|您)(?:刚才|提出)?的(?:问题|提问)/u.test(String(text??''));}
const questionPhrases=text=>{const result=new Set();for(const part of normalized(text).match(/\p{Script=Han}{10,}/gu)??[]){const chars=Array.from(part);for(let i=0;i<=chars.length-10;i++)result.add(chars.slice(i,i+10).join(''));}return result;};

export function assertSocialNovelty(journal,id,question,text,now=Date.now(),cooldownMs=14400000,{unanswered=0,domain,owner}={}){
  const words=String(question??'')+'\n'+String(text??'');
  // Reject explicit reply pressure without confusing "还没回家" with a reply.
  if(replyPressureRisk(words))throw new Error('SOCIAL_REPLY_PRESSURE');
  if(outboundReplyRoleRisk(text))throw new Error('SOCIAL_TASK_ROLE_MISMATCH');
  // A new topic key alone must not permit reformulating an unanswered question.
  if(unanswered>0&&/(?:上次|之前|刚才|前面|刚刚)[^。！？!?\n]{0,8}(?:我问|问过|问你|问到|的问题)|(?:再问|接着问|继续问|换个(?:问法|说法))/u.test(String(question??'')))throw new Error('REPEATED_SOCIAL_TOPIC');
  const repeated=repeatedLongTermTopic(journal,domain,id,question,text,now,owner);if(repeated){const error=new Error('REPEATED_SOCIAL_TOPIC');error.topicMatch={reason:repeated.reason,status:repeated.status,avoidUntil:repeated.avoidUntil};throw error;}
  const q=normalized(question),body=normalized(text),phrases=unanswered>0?questionPhrases(question):new Set();
  const barrier=journal.value(id,'memoryContextBarrierAt',0);
  for(const c of journal.value(id,'socialContacts',[]).filter(c=>now-c.at<cooldownMs&&(!domain||c.at>barrier&&(c.ownerAnchor==='initial'||typeof c.ownerAnchor==='string'&&domain.sourceUsable(id,c.ownerAnchor)))).slice(-16)){
    if(phrases.size&&[...questionPhrases(c.question)].some(part=>phrases.has(part)))throw new Error('REPEATED_SOCIAL_TOPIC');
    const old=journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND event_key=?").get(id,'assistant:'+c.messageId)?.text;
    if(q&&digest(q)===digest(c.question)||body&&old&&digest(body)===digest(old))throw new Error('REPEATED_SOCIAL_TOPIC');
    const b=normalized(old);
    if(body.length>=16&&b.length>=16){const a=bigrams(body),bs=bigrams(b),common=[...a].filter(v=>bs.has(v)).length;if(common/(a.size+bs.size-common)>.8)throw new Error('REPEATED_SOCIAL_TOPIC');}
  }
}

// Called inside the durable response commit transaction, including crash recovery.
export function commitSocialContact(journal,id,contact){
  const rows=journal.value(id,'socialContacts',[]);if(rows.some(c=>c.messageId===contact.messageId)){commitTopicMemory(journal,id,contact);return;}
  rows.push(contact);journal.put(id,'socialContacts',rows.slice(-64));
  commitTopicMemory(journal,id,contact);
  journal.audit(id,'social-contact-committed',{taskId:contact.taskId,messageId:contact.messageId,kind:contact.kind,topicKey:contact.topicKey,origin:'timer'});
}
