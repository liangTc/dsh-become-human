// Learning is private work; an offer is a short invitation, not delivery of a
// lesson. These bounded lexical rules adjust route priority only. They never
// create a user preference, infer dislike from silence, or grant permissions.
import {createHash} from 'node:crypto';
import {developmentInput,questionSignals,retrievalTerms} from './knowledge-signals.mjs';

const DAY=86400000,HOUR=3600000,KEY='learningEngagement';
export const learningEngagementPolicy=Object.freeze({version:3,maxOffers:64,maxRoutes:128,maxOwnerRows:512,maxOfferChars:120,retentionMs:90*DAY,responseWindowMs:24*HOUR,silentAfterMs:24*HOUR,silentCooldownMs:3*DAY,rejectionCooldownMs:7*DAY,decayMs:14*DAY});
const normalize=text=>String(text??'').normalize('NFKC').toLowerCase();
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const clean=text=>normalize(text).replace(/https?:\/\/\S+/gu,' ').replace(/【[^】]*】/gu,' ').replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gu,' ').replace(/最近|这两天|刚刚|我在|正在|开始|打算|想要|想学|在学|学习|研究|了解|分享|讲讲|说说|关于|相关|内容|东西|一些|一点|一下|这个|那个|你觉得|怎么样|有什么|为什么|是什么/gu,' ');

const compactNoteTitle=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const noteTitleCore=value=>String(value??'').normalize('NFKC').split(/[_|—–]/u)[0].replace(/^(?:原文摘录|来源原文摘录|来源摘录)\s*[·•:：-]?\s*/u,'');
const noteMessageText=message=>Array.isArray(message?.content)?message.content.filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';

// Exact selectors and ambiguity remain explicit. A natural reference without
// either can be interpreted by the model through the existing read-only tools.
export function delegateLearningLookup(probe,messages){
  if(!probe?.requested||probe.noteId||probe.ambiguous||probe.reason!=='explicit-note-not-found')return false;
  const text=(messages??[]).map(noteMessageText).join('\n');
  return !/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|[“「『《"][^”」』》"\n]{1,200}[”」』》"]/iu.test(text);
}

// This records a model-interpreted reference only after its reply commits.
// It changes bounded route attention, never a user preference or permission.
export function commitLearningFollowUp(journal,id,value){
  if(!value||!['noteId','ownerSourceId','assistantMessageId','sourceId'].every(k=>safeId(value[k]))||!Number.isSafeInteger(value.memoryVersion)||typeof value.sourceHash!=='string')return false;
  const origin=journal.value(id,'dialogue-origin:'+value.assistantMessageId,null);
  if(origin?.lane!=='foreground'||!Array.isArray(origin.inputIds)||!origin.inputIds.includes(value.ownerSourceId))return false;
  const now=Math.max(Date.now(),journal.value(id,'timeHighWater',0));
  const row=journal.db.prepare("SELECT n.source_id,m.version,m.refs,s.hash,s.root FROM learning_note n JOIN memory_record m ON m.agent=n.agent AND m.id=n.memory_id JOIN source_record s ON s.agent=n.agent AND s.id=n.source_id WHERE n.agent=? AND n.id=? AND n.status='active' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active'").get(id,value.noteId,now);
  if(!row||row.source_id!==value.sourceId||row.version!==value.memoryVersion||row.hash!==value.sourceHash||!JSON.parse(row.refs).includes(row.source_id)||journal.db.prepare('SELECT 1 FROM extraction_block WHERE agent=? AND source=?').get(id,row.root))return false;
  journal.audit(id,'learning-follow-up-committed',{noteId:value.noteId,ownerSourceId:value.ownerSourceId,assistantMessageId:value.assistantMessageId,sourceId:value.sourceId,sourceHash:value.sourceHash,memoryVersion:value.memoryVersion,scope:'model-interpreted-current-owner-reference',isUserPreference:false});return true;
}

/** Resolve a current, explicit saved-note request without inventing an offer,
 * owner interest or new permission. The caller supplies only currently usable
 * notes and must retain normal source checks before assembling any context. */
export function explicitLearningNoteRequest(messages,notes){
  const none=reason=>({requested:false,ownerSourceId:null,noteId:null,ambiguous:false,reason});
  if(!Array.isArray(messages)||!messages.length||messages.length>16||messages.some(m=>!safeId(m?.id)||m.role!==undefined&&m.role!=='user'))return none('invalid-current-owner-input');
  const text=messages.map(noteMessageText).join('\n');if(!text.trim()||text.length>16000)return none('invalid-current-owner-input');
  const lastText=noteMessageText(messages.at(-1)).trim();
  if(/(?:不聊|别聊|停止聊)(?:这份|那份|学习)?笔记|(?:先)?(?:别|不要|不用|不想|停止)(?:再|继续)?(?:核对|查阅|阅读|解读|读|看|讲|聊|展开).{0,12}(?:学习笔记|笔记)/u.test(lastText)||/^(?:先停一下|停一下|不用了|算了|先等等|先不讲了|别继续了)(?:[，,。！？!?\s]|$)/u.test(lastText))return none('owner-stopped-note-request');
  if(/[a-z][a-z0-9+.-]*:\/\/|\bwww\./iu.test(text))return none('explicit-url-needs-current-read');
  if(/(?:先不聊|不想聊|换个话题|聊点别的|不要再讲|别再讲)/u.test(text))return none('owner-changed-topic');
  if(!/(?:学习笔记|学习记录|已保存笔记|刚保存.{0,32}笔记|这份笔记|那份笔记|笔记)/u.test(text))return none('not-a-saved-note-request');
  if(/(?:有哪些|有哪几|笔记列表|所有(?:的)?(?:学习)?笔记|全部(?:的)?(?:学习)?笔记|列出(?:你|目前|当前|已保存|所有|全部|的|学习)*笔记)/u.test(text))return none('note-list-request');
  const verify=/(?:核对|查阅|阅读|解读|读一下|读一读|看一下|看看|解释|讲讲|说说|展开|怎么理解|如何理解|哪里(?:提到|写|说)|(?:写了|说了|讲了|提到|说明|介绍|结论|主要内容|学到了).{0,8}(?:什么|哪些|哪一|啥)|有什么(?:内容|结论|依据)|是什么意思)/u.test(text);
  if(!verify)return none('no-explicit-note-content-request');
  const ownerSourceId=messages.at(-1).id,requested=(reason,ambiguous=false)=>({requested:true,ownerSourceId,noteId:null,ambiguous,reason});
  if(!Array.isArray(notes)||notes.length>100)return requested('invalid-usable-note-catalog');
  const usable=notes.filter(note=>safeId(note?.id)&&note.status==='active'&&note.sourceValid!==false&&typeof note.data?.title==='string'&&note.data.title.trim()&&Array.isArray(note.data.claims)&&note.data.claims.length&&typeof note.data.source?.url==='string'&&/^[a-f0-9]{64}$/iu.test(note.data.source?.digest??''));
  const references=[...new Set((text.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu)??[]).map(normalize))];
  if(references.length){
    if(references.length!==1)return requested('multiple-explicit-note-identifiers',true);
    const exact=usable.filter(note=>normalize(note.id)===references[0]);
    return exact.length===1?{requested:true,ownerSourceId,noteId:exact[0].id,ambiguous:false,reason:'explicit-note-identifier'}:requested(exact.length?'duplicate-explicit-note-identifier':'explicit-note-not-found',exact.length>1);
  }
  const quoted=[...text.matchAll(/[“「『《"]([^”」』》"\n]{1,200})[”」』》"]/gu)].map(match=>compactNoteTitle(noteTitleCore(match[1]))).filter(Boolean),body=compactNoteTitle(text);
  const titles=usable.map(note=>({note,full:compactNoteTitle(note.data.title),core:compactNoteTitle(noteTitleCore(note.data.title))}));
  const titleMatches=(query,row)=>query===row.full||query===row.core||query.length>=6&&(row.full.includes(query)||row.core.includes(query));
  let matched=quoted.length?titles.filter(row=>quoted.some(query=>titleMatches(query,row))):titles.filter(row=>row.core.length>=4&&body.includes(row.core)||row.full.length>=4&&body.includes(row.full));
  if(!matched.length)return requested('explicit-note-not-found');
  // Exact duplicate material may be stored twice. Different sources, selected
  // spans or annotations remain ambiguous even when their displayed title is
  // identical; a recent timestamp alone must not silently choose one.
  const identities=new Map();
  for(const row of matched){const note=row.note,identity=JSON.stringify({url:note.data.source.url,digest:note.data.source.digest,claims:note.data.claims.map(c=>({text:c.text,quote:c.quote})),ownerRevision:note.data.ownerRevision??null}),previous=identities.get(identity);if(!previous||(note.created??0)>(previous.created??0)||(note.created??0)===(previous.created??0)&&note.id.localeCompare(previous.id)<0)identities.set(identity,note);}
  matched=[...identities.values()];
  if(matched.length!==1)return requested('multiple-matching-learning-notes',true);
  return {requested:true,ownerSourceId,noteId:matched[0].id,ambiguous:false,reason:'explicit-note-title'};
}

// No role-specific topics or publisher whitelist. Equal keyword sets have a
// stable key; related wording is compared lexically at lookup, not asserted to
// be semantically identical. No raw route wording is persisted in metadata.
export function learningRoute(text){
  const value=String(text??'').normalize('NFKC').slice(0,1200),signals=questionSignals(value),body=clean(value);
  const terms=[...new Set(retrievalTerms(body,{expand:false,limit:32}).filter(term=>term.length>=2&&!/^\d+$/u.test(term)))].sort().slice(0,24);
  const httpStatusCodes=signals.httpStatusCodes??[];
  const identifiers=[...new Set([...httpStatusCodes,...signals.identifiers.filter(term=>terms.includes(term))])].sort().slice(0,8);
  // Preserve concrete code/API names separately from shared protocol acronyms.
  // A common "HTTP" or "API" must not hide two different named subjects.
  const specificIdentifiers=[...new Set([...httpStatusCodes,...(value.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)??[]).filter(word=>/[a-z][A-Z]|[A-Za-z]\d/u.test(word)).map(normalize)])].sort().slice(0,8);
  // Identifiers are anchors, not a complete topic. A shared publisher, product
  // or API name must not merge all questions about it into one feedback route.
  const signature=JSON.stringify({specificIdentifiers,identifiers,terms});
  return {key:createHash('sha256').update(signature).digest('hex').slice(0,24),terms,identifiers,specificIdentifiers,httpStatusCodes,lexicalOnly:true,empty:terms.length===0};
}

function ledger(journal,id,now){
  const stored=journal.value(id,KEY,null),offers=Array.isArray(stored?.offers)?stored.offers:[],routes=Array.isArray(stored?.routes)?stored.routes:[];
  return {offers:offers.filter(row=>row&&safeId(row.messageId)&&safeId(row.noteId)&&safeId(row.sourceId)&&Number.isSafeInteger(row.at)&&row.at<=now&&now-row.at<learningEngagementPolicy.retentionMs).sort((a,b)=>a.at-b.at||a.messageId.localeCompare(b.messageId)).slice(-learningEngagementPolicy.maxOffers),routes:routes.filter(row=>row&&/^[a-f0-9]{24}$/u.test(row.key??'')&&Number.isSafeInteger(row.lastOfferedAt)&&row.lastOfferedAt<=now&&now-row.lastOfferedAt<learningEngagementPolicy.retentionMs).sort((a,b)=>a.lastOfferedAt-b.lastOfferedAt).slice(-learningEngagementPolicy.maxRoutes)};
}

function usable(domain,id,sourceId){return sourceId==='initial'||safeId(sourceId)&&typeof domain?.sourceUsable==='function'&&domain.sourceUsable(id,sourceId);}
function noteMaterial(journal,domain,id,offer,now){
  if(!usable(domain,id,offer.sourceId)||!usable(domain,id,offer.ownerAnchor))return null;
  // Read canonical material only after its provenance remains usable. A
  // withdrawn/corrected note must not survive through a metadata text copy.
  const row=journal.db.prepare("SELECT n.data,n.feedback,m.refs FROM learning_note n JOIN memory_record m ON m.agent=n.agent AND m.id=n.memory_id JOIN source_record s ON s.agent=n.agent AND s.id=n.source_id WHERE n.agent=? AND n.id=? AND n.source_id=? AND n.status='active' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.status='active'").get(id,offer.noteId,offer.sourceId,now);
  if(!row)return null;
  let data,refs,feedback;try{data=JSON.parse(row.data);refs=JSON.parse(row.refs);feedback=row.feedback?JSON.parse(row.feedback):null;}catch{return null;}
  if(!data||data.developmentOnly||!Array.isArray(refs)||!refs.includes(offer.sourceId)||!refs.every(ref=>usable(domain,id,ref)&&journal.db.prepare("SELECT 1 FROM source_record WHERE agent=? AND id=? AND status='active'").get(id,ref)))return null;
  if(developmentInput(feedback?.comment)||developmentInput(data.ownerRevision?.summary))return null;
  if(safeId(data.taskId)){
    const task=journal.db.prepare('SELECT checkpoint FROM autonomy_task WHERE agent=? AND id=?').get(id,data.taskId);
    let checkpoint;try{checkpoint=JSON.parse(task?.checkpoint??'null');}catch{return null;}
    if(developmentInput(checkpoint?.plan?.question??'')||developmentInput(checkpoint?.candidate?.question??'')||developmentInput(checkpoint?.correction?.comment))return null;
    const goalId=typeof checkpoint?.goal==='string'?checkpoint.goal:checkpoint?.goal?.id;
    if(safeId(goalId)){
      const goal=journal.db.prepare('SELECT description,refs FROM goal_record WHERE agent=? AND id=?').get(id,goalId);
      if(!goal)return null;
      let goalRefs;try{goalRefs=JSON.parse(goal.refs);}catch{return null;}
      if(!Array.isArray(goalRefs)||!goalRefs.every(ref=>usable(domain,id,ref)))return null;
      if(developmentInput(goal.description))return null;
    }
  }
  const question=String(data.researchQuestion??''),title=String(data.title??'');
  if(developmentInput(question)||developmentInput(title))return null;
  return {question,title,route:learningRoute(question+' '+title),materialText:[question,title,...(Array.isArray(data.claims)?data.claims.slice(0,4).map(claim=>String(claim.text??'')):[])].join(' '),sourceUrls:[data.source?.requestedUrl,data.source?.url].map(materialUrl).filter(Boolean),sourceDigest:typeof data.source?.digest==='string'?data.source.digest:null};
}

function materialUrl(value){
  if(typeof value!=='string'||value.length>2048)return null;
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;url.hash='';return url.href;}catch{return null;}
}

function conflictingMaterial(offer,text){
  const urls=Array.from(String(text).matchAll(/https?:\/\/[^\s<>"'，。！？）)]+/giu),match=>materialUrl(match[0])).filter(Boolean);
  if(urls.some(url=>!offer.sourceUrls?.includes(url)))return true;
  const material=normalize(offer.materialText??offer.question+' '+offer.title).replace(/[^\p{L}\p{N}]/gu,'');
  return Array.from(String(text).matchAll(/《([^》]{1,100})》/gu),match=>normalize(match[1]).replace(/[^\p{L}\p{N}]/gu,'')).some(title=>title&&!material.includes(title));
}

// An omitted subject can refer to the immediately active invitation, but an
// unrecognised named subject is not an omitted subject. Keep this conservative:
// a named request can always recover its actual note through normal retrieval.
function implicitReferenceOnly(text){
  return !normalize(text)
    .replace(/(?:tell me more|explain(?: it)?|how does (?:it|that) work|why is that|what (?:is|are) (?:it|that)|please)/giu,' ')
    .replace(/(?:具体怎么回事|怎么回事|什么原理|有什么用|有什么|在学什么|学的什么|学到什么|怎么用|怎么做|怎么|如何|为什么|展开讲讲|展开说说|展开|讲给我听|说来听听|想听听|想听|感兴趣|讲讲|说说|解释|详细|具体|继续|你说的|你提的|你学的|你研究的|刚才|刚刚|之前|最近|这两天|这一段|那一段|这段|那段|这份|那份|这页|那页|这个|那个|这件事|那件事|这件|那件|这方面|那方面|这话题|那话题|话题|内容|东西|资料|材料|网页|页面|文章|笔记|学习|研究|在学|学到|听听|请|可以|能不能|能|我|你|您|我们|一下|一点|一些|一遍|说|提|的|了|吗|呢|吧|呀|啊)/gu,' ')
    .replace(/[^\p{L}\p{N}]/gu,'');
}

// Reads are explicit foreground material boundaries, not new learning offers.
// Inspect only a bounded audit window and small canonical job fields. Missing
// or mixed targets close a pronoun fallback rather than guessing an old note.
function foregroundReads(journal,id,since,now){
  let raw;try{raw=journal.db.prepare("SELECT seq,data FROM audit WHERE agent=? AND kind='capability-dialogue-observed' ORDER BY seq DESC LIMIT ?").all(id,learningEngagementPolicy.maxOwnerRows+1);}catch{return {events:[],coverageSince:now};}
  const parsed=raw.flatMap(row=>{try{const data=JSON.parse(row.data);return Number.isSafeInteger(data.time)?[{...data,seq:row.seq}]:[];}catch{return [];}}),events=[];
  for(const row of parsed){
    if(row.time<=since||row.time>now||row.lane!=='foreground'||row.origin!=='owner'||row.status!=='completed'||!safeId(row.jobId))continue;
    let url=null,digest=null,noteIds=null;
    try{
      const job=journal.db.prepare('SELECT CASE WHEN length(input)<=16384 THEN input END AS input,CASE WHEN length(result)<=131072 THEN result END AS result FROM human_tool_job WHERE agent=? AND id=?').get(id,row.jobId),input=JSON.parse(job?.input??'null'),result=JSON.parse(job?.result??'null');url=materialUrl(input?.url);digest=typeof result?.digest==='string'?result.digest:null;
      if(row.tool==='list-learning-notes'&&Array.isArray(result?.items)&&result.truncated!==true&&result.hasMore!==true&&(!Number.isFinite(result.total)||result.total<=result.items.length))noteIds=result.items.slice(0,16).map(note=>note?.id).filter(safeId);
      if(row.tool==='read-learning-note'&&safeId(result?.note?.id)&&result.truncated!==true)noteIds=[result.note.id];
    }catch{}
    events.push({at:row.time,seq:row.seq,url,digest,noteIds});
  }
  return {events:events.sort((a,b)=>a.at-b.at||a.seq-b.seq),coverageSince:raw.length>learningEngagementPolicy.maxOwnerRows?Math.min(...parsed.map(row=>row.time),now):since};
}

function ownerRows(journal,domain,id,since,now){
  if(typeof domain?.sourceUsable!=='function')return {rows:[],coverageSince:now};
  const raw=journal.db.prepare("SELECT event_key,text,created FROM outbox WHERE agent=? AND kind='user' AND event_key LIKE 'user:%' AND created>=? AND created<=? ORDER BY created DESC,seq DESC LIMIT ?").all(id,since,now,learningEngagementPolicy.maxOwnerRows).reverse();
  const resolved=new Map();
  const references=journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit'").get()?journal.db.prepare("SELECT data FROM audit WHERE agent=? AND kind='learning-follow-up-committed' ORDER BY seq DESC LIMIT ?").all(id,learningEngagementPolicy.maxOwnerRows):[];
  for(const row of references){let ref;try{ref=JSON.parse(row.data);}catch{continue;}const origin=journal.value(id,'dialogue-origin:'+ref.assistantMessageId,null);
    if(!Number.isSafeInteger(ref.time)||ref.time<since||ref.time>now||origin?.lane!=='foreground'||!origin.inputIds?.includes(ref.ownerSourceId)||!usable(domain,id,ref.sourceId)||!journal.db.prepare("SELECT 1 FROM outbox WHERE agent=? AND kind='assistant' AND event_key=?").get(id,'assistant:'+ref.assistantMessageId))continue;
    const ids=resolved.get(ref.ownerSourceId)??new Set();ids.add(ref.noteId);resolved.set(ref.ownerSourceId,ids);
  }
  return {rows:raw.map(row=>({sourceId:row.event_key.slice(5),text:row.text,at:row.created,resolvedNoteIds:[...(resolved.get(row.event_key.slice(5))??[])]})).filter(row=>usable(domain,id,row.sourceId)&&!developmentInput(row.text)),coverageSince:raw.length===learningEngagementPolicy.maxOwnerRows?raw[0].created:since};
}

function related(a,b){
  if(a.empty||b.empty)return false;
  if(a.key===b.key)return true;
  const concreteA=a.specificIdentifiers??[],concreteB=b.specificIdentifiers??[];
  if(concreteA.length&&concreteB.length&&!concreteA.some(term=>concreteB.includes(term)))return false;
  const anchors=new Set([...(a.identifiers??[]),...(b.identifiers??[]),...concreteA,...concreteB]);
  const topicsA=a.terms.filter(term=>!anchors.has(term)),topicsB=b.terms.filter(term=>!anchors.has(term));
  const common=topicsA.filter(term=>topicsB.includes(term)).length;
  return common>=2&&common/Math.max(1,Math.min(topicsA.length,topicsB.length))>=.4;
}

function responseKind(offer,row,{deicticAllowed=true,resolvedNote=false}={}){
  const text=normalize(row.text),conflict=conflictingMaterial(offer,text),named=!conflict&&(resolvedNote||related(offer.route,learningRoute(text))),recent=row.at-offer.at<=learningEngagementPolicy.responseWindowMs,implicit=deicticAllowed&&!conflict&&implicitReferenceOnly(text);
  const deictic=/(?:刚才|你说的|你提的|这个|那个|这件|那件|这方面|那方面|这话题|那话题)/u.test(text);
  const rejects=/(?:不想|不要|别|不用|不必|不感兴趣|没兴趣|停止|不再).{0,12}(?:听|聊|讲|分享|推送|介绍|讨论|学)|(?:不感兴趣|没兴趣)(?:[。！!，,\s]|$)/u.test(text);
  const switches=/(?:换|转)(?:个|一?个)?话题|(?:先|今天|现在).{0,8}(?:聊点别的|聊别的|说别的)|(?:晚点|以后|稍后|改天).{0,6}(?:再说|再聊|再讲)/u.test(text);
  const directDecline=/^(?:我)?(?:先|暂时)?(?:不感兴趣|没兴趣|不想听|不想聊|不用讲|不用说|不要分享|别讲了|别说了)[。！!，,\s]*$/u.test(text);
  const directSwitch=/^(?:(?:我们)?(?:先)?(?:换|转)(?:个|一个)?话题|(?:先|今天|现在)?(?:聊点别的|聊别的|说别的)|(?:晚点|以后|稍后|改天)再(?:说|聊|讲))[。！!，,\s]*$/u.test(text);
  if(rejects&&(named||recent&&deicticAllowed&&!conflict&&(directDecline||deictic&&implicit)))return 'declined';
  if(switches&&(named||recent&&deicticAllowed&&!conflict&&(directSwitch||deictic&&implicit)))return 'changed-topic';
  if(resolvedNote&&!conflict)return 'interested';
  // An acknowledgement, greeting, or generic "continue" is never interest.
  // Omitted subjects require an explicit learning/previous-message reference.
  const ask=/(?:讲讲|说说|展开|详细|具体|怎么|如何|为什么|什么原理|有何|有什么|什么用|有用吗|学到了什么|在学什么|学的什么|想听|说来听听|tell me more|explain|how does|why does|what is|what are|\?)/iu.test(text);
  const directFollowUp=/^(?:我)?(?:想听|想听听|展开讲讲|展开说说|具体讲讲|具体说说|说来听听|讲给我听)[。！!？?，,\s]*$/u.test(text);
  const explicitlyElsewhere=/(?:另一个|另外一个|无关|换个|新(?:的)?问题|另一件事)/u.test(text),explicitLearningReference=/(?:你(?:刚才|之前)?(?:说|提|学|研究)的|刚才.{0,8}(?:学习|研究|话题))/u.test(text);
  if(!named&&explicitlyElsewhere&&!explicitLearningReference)return null;
  const learningReference=directFollowUp||/(?:你(?:最近|刚才|这两天)?(?:在学|学到|研究|说)的|你(?:最近|这两天)?(?:在学|学|在研究|研究)什么|(?:刚才|你说的|你提的|这个|那个).{0,12}(?:展开|讲讲|说说|具体|详细|怎么|如何|为什么|什么原理|什么用)|(?:展开|讲讲|说说|具体|详细).{0,12}(?:刚才|你说的|你提的|这个|那个)|学到了什么|说来听听)/u.test(text);
  return (ask||directFollowUp)&&(named||recent&&implicit&&learningReference)?'interested':null;
}

function evaluatedOffer(offer,replies,nextAt,now,coverageSince,reads){
  // Each owner row belongs to its single most recent offer, never every
  // historical route. At most one current outcome is counted per offer.
  const later=replies.filter(row=>row.at>offer.at&&row.at<nextAt),meaningful=[];let deicticAllowed=reads.coverageSince<=offer.at&&coverageSince<=offer.at,previousAt=offer.at;
  for(const row of later){
    if(reads.events.some(event=>event.at>previousAt&&event.at<=row.at&&!(event.url&&offer.sourceUrls?.includes(event.url)&&event.digest&&event.digest===offer.sourceDigest)&&!(event.noteIds?.length===1&&event.noteIds[0]===offer.noteId)))deicticAllowed=false;
    const kind=responseKind(offer,row,{deicticAllowed,resolvedNote:row.resolvedNoteIds?.includes(offer.noteId)});if(kind)meaningful.push({row,kind});
    // A new, explicitly named interest can reopen its own route. Unrelated
    // conversation, an acknowledgement, or a refusal closes omitted subjects.
    deicticAllowed=kind==='interested';previousAt=row.at;
  }
  const last=meaningful.at(-1);
  const status=last?.kind??(later.length?'owner-replied-elsewhere':coverageSince>offer.at?'unobserved-window':now-offer.at>=learningEngagementPolicy.silentAfterMs?'no-follow-up':'awaiting-owner-interest'),responseAt=last?.row.at??later.at(-1)?.at??offer.at;
  const penalty=status==='declined'?-.5:['changed-topic','owner-replied-elsewhere'].includes(status)?-.2:status==='no-follow-up'?-.15:status==='interested'?.3:0;
  const effect=penalty*Math.max(0,1-(now-responseAt)/learningEngagementPolicy.decayMs);
  const cooldownUntil=status==='interested'?null:status==='declined'?responseAt+learningEngagementPolicy.rejectionCooldownMs:['changed-topic','owner-replied-elsewhere'].includes(status)?responseAt+learningEngagementPolicy.silentCooldownMs:offer.at+(status==='no-follow-up'?learningEngagementPolicy.silentCooldownMs:learningEngagementPolicy.silentAfterMs);
  const {materialText,sourceUrls,sourceDigest,...publicOffer}=offer;
  const modelReference=status==='interested'&&last?.row.resolvedNoteIds?.includes(offer.noteId);
  return {...publicOffer,status,responseSourceId:last?.row.sourceId??later.at(-1)?.sourceId??null,interestedSourceId:status==='interested'?last.row.sourceId:null,responseAt:last?.row.at??later.at(-1)?.at??null,weight:clamp(1+effect,.25,1.5),cooldownUntil:cooldownUntil>now?cooldownUntil:null,reason:status,evidenceKind:modelReference?'model-interpreted-owner-reference':['no-follow-up','owner-replied-elsewhere'].includes(status)?'weak-attention-signal':status==='unobserved-window'?'insufficient-observation':status==='awaiting-owner-interest'?'pending':'explicit-owner-response',semanticVerified:false,isUserPreference:false};
}

export function learningEngagementSnapshot(journal,domain,id,now=Date.now()){
  const stored=ledger(journal,id,now),barrier=journal.value(id,'memoryContextBarrierAt',0),valid=[];
  for(const offer of stored.offers){
    if(offer.at<=barrier)continue;
    const material=noteMaterial(journal,domain,id,offer,now);if(!material||material.route.empty)continue;
    const body=journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND kind='assistant' AND event_key=?").get(id,'assistant:'+offer.messageId)?.text;
    if(typeof body!=='string'||developmentInput(body))continue;
    valid.push({...offer,route:material.route,materialText:material.materialText,sourceUrls:material.sourceUrls,sourceDigest:material.sourceDigest,question:material.question.slice(0,160),title:material.title.slice(0,100),text:Array.from(body).slice(0,learningEngagementPolicy.maxOfferChars).join('')});
  }
  const replyWindow=valid.length?ownerRows(journal,domain,id,valid[0].at,now):{rows:[],coverageSince:now},reads=valid.length?foregroundReads(journal,id,valid[0].at,now):{events:[],coverageSince:now},evaluated=valid.map(offer=>{
    // Use the next row in the stable ledger order, including equal timestamps,
    // so a single reply cannot be credited to several same-millisecond offers.
    // An invalidated later offer still closes the older response window without
    // recalling its body.
    const storedIndex=stored.offers.findIndex(row=>row.messageId===offer.messageId),nextAt=stored.offers[storedIndex+1]?.at??Infinity;
    return evaluatedOffer(offer,replyWindow.rows,nextAt,now,replyWindow.coverageSince,reads);
  });
  const groups=new Map();
  for(const offer of evaluated){const group=groups.get(offer.route.key)??[];group.push(offer);groups.set(offer.route.key,group);}
  const routes=[...groups].map(([key,offers])=>{
    const last=offers.at(-1),recent=offers.slice(-3),lastInterest=recent.findLast(row=>row.status==='interested');
    // A later explicit interest restores the route immediately; past silence
    // or a refusal is not a permanent personal characteristic.
    const selected=lastInterest&&lastInterest.at>=last.at?[lastInterest]:recent;
    return {key,terms:last.route.terms,identifiers:last.route.identifiers,specificIdentifiers:last.route.specificIdentifiers,httpStatusCodes:last.route.httpStatusCodes,lexicalOnly:true,weight:clamp(1+selected.reduce((sum,row)=>sum+row.weight-1,0),.25,1.5),cooldownUntil:last.cooldownUntil,reason:last.status,lastOfferedAt:last.at,offers:offers.length,responseSourceId:last.responseSourceId,interestedSourceId:last.interestedSourceId,isUserPreference:false};
  }).sort((a,b)=>b.lastOfferedAt-a.lastOfferedAt).slice(0,learningEngagementPolicy.maxRoutes);
  return {version:learningEngagementPolicy.version,method:'committed-note-reference-with-lexical-fallback',routes,offers:evaluated,latestOffer:evaluated.at(-1)??null,retainedContactCount:stored.offers.length,limitations:['Silence is weak attention evidence, never dislike or a durable user preference.','Model-selected current note references are source checked, not semantically verified owner preferences.','Fallback topic matching is lexical; unknown or ambiguous responses do not authorize a lesson.','Explicit owner requests and active goals should bypass autonomous route ranking.']};
}

// Invoke only when the assistant response has durably committed. This helper
// does not publish, open transactions, call models, or write a preference.
export function commitLearningOffer(journal,id,offer){
  if(!offer||!safeId(offer.messageId)||!safeId(offer.noteId)||!safeId(offer.sourceId)||!Number.isSafeInteger(offer.at)||!(offer.ownerAnchor==='initial'||safeId(offer.ownerAnchor)))return {committed:false,reason:'invalid-offer'};
  const text=String(offer.text??''),question=String(offer.question??''),route=learningRoute(offer.routeText??question);
  if(!text.trim()||Array.from(text).length>learningEngagementPolicy.maxOfferChars||route.empty||developmentInput(text)||developmentInput(question)||developmentInput(offer.routeText??''))return {committed:false,reason:'not-a-real-short-learning-offer'};
  const current=ledger(journal,id,Math.max(Date.now(),offer.at)),existing=current.offers.find(row=>row.messageId===offer.messageId);
  if(existing)return {committed:false,reason:'already-committed',key:existing.routeKey};
  // Old crash replay must not evict recent offers or move a route backwards
  // once the bounded ledger has discarded its original identity.
  if(current.offers.length>=learningEngagementPolicy.maxOffers&&offer.at<=current.offers[0].at)return {committed:false,reason:'outside-retained-window',key:route.key};
  const previousRoute=current.routes.find(item=>item.key===route.key);
  const row={messageId:offer.messageId,noteId:offer.noteId,sourceId:offer.sourceId,ownerAnchor:offer.ownerAnchor,at:offer.at,routeKey:route.key};
  journal.put(id,KEY,{version:learningEngagementPolicy.version,offers:[...current.offers,row].sort((a,b)=>a.at-b.at||a.messageId.localeCompare(b.messageId)).slice(-learningEngagementPolicy.maxOffers),routes:[...current.routes.filter(item=>item.key!==route.key),{key:route.key,lastOfferedAt:Math.max(previousRoute?.lastOfferedAt??0,offer.at)}].sort((a,b)=>a.lastOfferedAt-b.lastOfferedAt).slice(-learningEngagementPolicy.maxRoutes)});
  return {committed:true,key:route.key};
}

export function routeDisposition(journal,domain,id,text,now=Date.now()){
  const candidate=learningRoute(text),snapshot=learningEngagementSnapshot(journal,domain,id,now),matches=snapshot.routes.filter(row=>related(candidate,{...row,empty:false}));
  const exact=matches.find(row=>row.key===candidate.key),selected=exact??(matches.length===1?matches[0]:null);
  if(selected)return {...selected,key:candidate.key,matchedKey:selected.key,known:true,lexicalOnly:true};
  // An opaque exact key permits short contact cooldowns after source removal,
  // without reviving its text, interest inference, or learning weight.
  const prior=ledger(journal,id,now).routes.find(row=>row.key===candidate.key),cooldownUntil=prior&&prior.lastOfferedAt+DAY>now?prior.lastOfferedAt+DAY:null;
  return {key:candidate.key,known:!!prior,weight:1,cooldownUntil,reason:prior?'contact-metadata-only':matches.length>1?'ambiguous-topic-match':'new-or-unmatched-route',lexicalOnly:true,isUserPreference:false};
}
