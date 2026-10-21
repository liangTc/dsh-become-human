// Bounded, deterministic topic memory. This is lexical matching with an
// explicit synonym dictionary; it does not claim full semantic understanding.
const DAY=86400000;
export const topicMemoryPolicy=Object.freeze({version:1,maxRecords:256,retentionMs:180*DAY,unansweredMs:30*DAY,answeredMs:7*DAY});
const normalize=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const developmentText=text=>/【开发(?:短测|测试)】|仅用于(?:开发)?测试|这(?:条|段|次).{0,12}(?:测试|不代表个人)|(?:测试|验证)(?:消息|指令)|(?:测试|验证)通过/u.test(String(text??''));
const domains=[
  ['coffee',/咖啡|拿铁|美式|意式|手冲|冷萃|coffee|espresso|latte/u],
  ['food',/吃饭|一顿饭|美食|饭菜|餐厅|菜品|好吃|口味|漂亮饭|摆盘|料理|food|meal/u],
  ['ai',/人工智能|大模型|语言模型|模型|agent|智能体|机器学习|deepseek|openai|qwen|\bai\b/u],
  ['life',/生活|日常|节奏|周末|空闲|闲暇|休息|routine/u],
  ['relationship',/陪伴|男朋友|女朋友|关系|约会|感情|想念/u],
  ['work',/工作|上班|下班|收工|项目|任务|deadline/u],
  ['sleep',/睡眠|睡觉|早睡|熬夜|几点睡|入睡/u],
  ['weather',/天气|温度|下雨|降温|气温/u],
];
const facets=[
  ['flavor',/味道|口味|风味|香气|酸度|甜度|苦味|好吃|好喝/u],
  ['presentation',/摆盘|颜值|漂亮|好看|审美/u],
  ['atmosphere',/环境|氛围|装修|安静|吵闹/u],
  ['company',/陪你|陪伴|一起吃|一起喝|和谁|那个人/u],
  ['priorities',/最看重|最在意|更看重|更在意|更重要|最重要|排序|排名|只(?:能)?(?:留|选)|值了|优先|取舍/u],
  ['beans',/豆子|咖啡豆|产区|产地|烘焙|浅烘|深烘/u],
  ['brewing',/冲煮|萃取|手冲|水温|研磨|粉水比/u],
  ['energy',/精神|疲惫|累不累|有点累|疲劳|状态|精力/u],
  ['routine',/节奏|作息|安排|习惯|几点|早睡|熬夜/u],
  ['workload',/加班|收工|下班|忙碌|忙不忙|进度|截止/u],
  ['models',/大模型|语言模型|模型|deepseek|qwen|gpt/u],
  ['frontier',/前沿|最新|新发布|发布|进展|新技术/u],
  ['configuration',/配置|凭据|api|密钥|参数|路由/u],
  ['agent',/agent|智能体|自主|自治/u],
  ['memory',/记忆|memory|召回|遗忘/u],
  ['learning',/学习|研究|论文|知识|读书/u],
  ['price',/价格|花费|多少钱|预算|便宜|贵不贵/u],
];
const stop=new Set(['你觉','觉得','什么','怎么','如果','可以','一个','这个','那个','的话','说起','起来','想问','问你','还是','时候','自己','喜欢','一下','问题','怎样','我们','现在','今天','刚才','之前','上次','继续','再聊','接着','比较']);
const tokenSets=new WeakMap();
const tokenSet=signature=>{if(!tokenSets.has(signature))tokenSets.set(signature,new Set(signature.tokens));return tokenSets.get(signature);};

export function topicFingerprint(text){
  const raw=String(text??'').normalize('NFKC').toLowerCase(),plain=normalize(raw),tokens=new Set();
  for(const word of raw.match(/[a-z0-9][a-z0-9_-]{1,}/gu)??[])tokens.add(word);
  for(const run of raw.match(/\p{Script=Han}+/gu)??[]){const chars=Array.from(run);for(let i=0;i<chars.length-1;i++){const token=chars[i]+chars[i+1];if(!stop.has(token))tokens.add(token);}}
  return {plain:plain.slice(0,1200),domains:domains.filter(([,re])=>re.test(raw)).map(([key])=>key),facets:facets.filter(([,re])=>re.test(raw)).map(([key])=>key),tokens:[...tokens].slice(0,160)};
}

export function topicSimilarity(a,b){
  if(a.plain.length>=8&&a.plain===b.plain)return {similar:true,reason:'same-wording'};
  const sharedDomains=a.domains.filter(v=>b.domains.includes(v)),sharedFacets=a.facets.filter(v=>b.facets.includes(v));
  if(sharedDomains.length&&sharedFacets.length>=2&&sharedFacets.length/Math.max(1,Math.min(a.facets.length,b.facets.length))>=.75)return {similar:true,reason:'same-domain-and-facets',domains:sharedDomains,facets:sharedFacets};
  const at=tokenSet(a),bt=tokenSet(b);let common=0;for(const token of at.size<bt.size?at:bt)if((at.size<bt.size?bt:at).has(token))common++;
  if(common>=6&&common/(at.size+bt.size-common)>=.55)return {similar:true,reason:'lexical-overlap'};
  return {similar:false,reason:'different-or-insufficient-signals'};
}

const usable=(domain,id,ref)=>ref==='initial'||typeof ref==='string'&&!!domain?.sourceUsable(id,ref);
function storedRecords(journal,id,now){
  const saved=journal.value(id,'socialTopicMemory',null),records=Array.isArray(saved?.records)?saved.records:[],seen=new Set(records.map(r=>r.messageId));
  // Read-through migration preserves existing conversations without requiring
  // a migration write or a model call. The next normal commit persists them.
  const legacy=journal.value(id,'socialContacts',[]).filter(c=>!seen.has(c.messageId));
  return [...records,...legacy].filter(r=>r&&typeof r.messageId==='string'&&Number.isSafeInteger(r.at)&&r.at<=now&&now-r.at<topicMemoryPolicy.retentionMs&&['chat','care'].includes(r.kind)&&!developmentText(r.question)).sort((a,b)=>a.at-b.at).slice(-topicMemoryPolicy.maxRecords);
}

function ownerRows(journal,id,since,domain,now){
  return journal.db.prepare("SELECT event_key,text,created FROM outbox WHERE agent=? AND kind='user' AND event_key LIKE 'user:%' AND created>=? AND created<=? ORDER BY created DESC,seq DESC LIMIT 256").all(id,since,now).reverse().map(row=>({id:row.event_key.slice(5),text:row.text,time:row.created})).filter(row=>usable(domain,id,row.id)&&!developmentText(row.text)).map(row=>({...row,signature:topicFingerprint(row.text)}));
}

function continuation(text){
  const body=String(text??'');
  return !/(?:不要|别|不想|不用|停止|不再|不必).{0,8}(?:继续|接着|再聊|聊下去)/u.test(body)&&/(?:继续|接着)(?:聊|说|谈|讨论)|(?:想|再)(?:聊聊|聊一聊|聊)[^。！？!?\n]{0,30}(?:话题|刚才|之前|上次)|(?:继续|接着)(?:刚才|之前|上次|这个|那个)(?:的)?(?:话题|讨论|问题)/u.test(body);
}

function topicReply(signature,row){
  const answer=row.signature;if(topicSimilarity(signature,answer).similar)return true;
  // A short direct answer can omit the subject ("我选味道"). Require an
  // answer cue plus an actual offered facet; an unrelated reply is not an
  // answer merely because it arrived later.
  return /(?:我(?:会|还是|更|最)?(?:选|看重|在意)|我的答案|对我来说|我偏好)/u.test(row.text)&&signature.facets.some(f=>answer.facets.includes(f));
}

export function topicMemoryRecords(journal,domain,id,now=Date.now(),owner){
  const barrier=journal.value(id,'memoryContextBarrierAt',0),records=storedRecords(journal,id,now).filter(r=>r.at>barrier&&usable(domain,id,r.ownerAnchor)).map(r=>({...r,signature:r.signature??topicFingerprint(r.question)}));
  if(!records.length)return [];
  const replies=ownerRows(journal,id,records[0].at,domain,now),lastContactAt=records.at(-1).at,latest=owner?replies.find(row=>row.id===owner.id):replies.at(-1),latestSignature=latest?.signature??topicFingerprint('');
  const deictic=/(?:刚才|之前|上次|这个|那个)(?:的)?(?:话题|讨论|问题)/u.test(latest?.text??'');
  const namedLatest=!deictic?records.filter(record=>(record.signature??topicFingerprint(record.question)).domains.some(key=>latestSignature.domains.includes(key))).at(-1)?.messageId:null;
  return records.map(record=>{
    const signature=record.signature??topicFingerprint(record.question),later=replies.filter(row=>row.time>record.at),reply=later.find(row=>topicReply(signature,row));
    // Generic "continue that topic" refers only to the latest contact, not
    // every older topic in the ledger. A named topic also needs a rule match.
    const requested=latest&&latest.time>record.at&&continuation(latest.text)&&(deictic?record.at===lastContactAt:record.messageId===namedLatest||topicSimilarity(signature,latestSignature).similar);
    const status=requested?'owner-requested-continuation':reply?'owner-replied-on-topic':later.length?'owner-replied-elsewhere':'awaiting-owner-reply';
    return {...record,signature,status,replySourceId:reply?.id??null,continuationSourceId:requested?latest.id:null,avoidUntil:reply?reply.time+topicMemoryPolicy.answeredMs:record.at+topicMemoryPolicy.unansweredMs};
  });
}

export function topicMemorySnapshot(journal,domain,id,now=Date.now(),owner){
  const records=topicMemoryRecords(journal,domain,id,now,owner),active=records.filter(r=>r.avoidUntil>now||r.continuationSourceId);
  return {method:'bounded-lexical-and-synonym-rules',records:records.length,unansweredDays:topicMemoryPolicy.unansweredMs/DAY,answeredDays:topicMemoryPolicy.answeredMs/DAY,topics:active.slice(-6).reverse().map(r=>({messageId:r.messageId,question:String(r.question??'').slice(0,100),topicKey:r.topicKey,at:r.at,status:r.status,avoidUntil:r.avoidUntil,continuationAllowed:!!r.continuationSourceId}))};
}

export function repeatedLongTermTopic(journal,domain,id,question,text,now=Date.now(),owner){
  // With no validated domain interface, never expose old content or allow a
  // continuation from unverified source text. Short-term guards still run.
  if(!domain?.sourceUsable)return null;
  const candidate=topicFingerprint(question+'\n'+text),candidateQuestion=topicFingerprint(question);
  for(const record of topicMemoryRecords(journal,domain,id,now,owner).reverse()){
    if(record.avoidUntil<=now)continue;
    const match=topicSimilarity(candidate,record.signature),questionMatch=topicSimilarity(candidateQuestion,topicFingerprint(record.question));
    if(!match.similar&&!questionMatch.similar)continue;
    if(record.continuationSourceId&&questionMatch.reason!=='same-wording')continue;
    return {messageId:record.messageId,status:record.status,reason:questionMatch.similar?questionMatch.reason:match.reason,avoidUntil:record.avoidUntil};
  }
  return null;
}

// Called in the existing response transaction; idempotent after crash replay.
export function commitTopicMemory(journal,id,contact){
  if(!['chat','care'].includes(contact.kind)||developmentText(contact.question))return;
  const records=storedRecords(journal,id,contact.at),old=records.find(r=>r.messageId===contact.messageId);
  if(old?.signature)return;
  const body=journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND event_key=?").get(id,'assistant:'+contact.messageId)?.text??'';
  const row={messageId:contact.messageId,taskId:contact.taskId,kind:contact.kind,topicKey:contact.topicKey,question:String(contact.question??'').slice(0,240),ownerAnchor:contact.ownerAnchor,at:contact.at,signature:topicFingerprint(contact.question+'\n'+body)};
  journal.put(id,'socialTopicMemory',{version:topicMemoryPolicy.version,records:[...records.filter(r=>r.messageId!==contact.messageId),row].slice(-topicMemoryPolicy.maxRecords)});
}
