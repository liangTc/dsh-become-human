import {createHash} from 'node:crypto';
import {researchUrl} from './learning.mjs';

const DAY=86400000,MAX_JOBS=64,MAX_AUDITS=32,MAX_OWNERS=6;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=value=>typeof value==='string'&&value.length>0&&value.length<=160;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/iu.test(value);
const compact=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const json=(text,limit)=>{if(typeof text!=='string'||Buffer.byteLength(text)>limit)throw new Error('INVALID_HISTORY_JSON');return JSON.parse(text);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const none=reason=>({materials:[],mode:'none',reason});
const ambiguous=reason=>({materials:[],mode:'ambiguous',reason});
const ids=(value,max)=>Array.isArray(value)&&value.length>0&&value.length<=max&&value.every(safeId)&&new Set(value).size===value.length;
const genericTitles=new Set(['首页','主页','文章','网页','页面','资料','介绍','无标题','home','index','about']);

function titleMatch(title,ownerText){
  // A known page title can also be an ordinary topic or preference. Require
  // a source-directed cue before a bare title activates extractive replies.
  if(!/(?:网页|页面|文章|资料|材料|原文|正文|(?:这|那|该)(?:一)?(?:页|篇|份))|(?:刚才|之前|前面|此前|上次).{0,32}(?:写了|讲了|说了|介绍了|读到|看到)/u.test(ownerText))return false;
  const body=compact(ownerText),parts=String(title).split(/[_|—–]/u).map(compact).filter(part=>part.length>=2&&!genericTitles.has(part));
  return parts.some(part=>body.includes(part));
}

function namedTargets(text){
  const quoted=Array.from(text.matchAll(/《([^》]{1,100})》/gu),match=>compact(match[1]));if(quoted.length)return quoted;
  // An explicit name may omit an author or site suffix, but generic character
  // overlap must not turn a differently named work into the requested source.
  return Array.from(text.matchAll(/(?:回到|说回|关于|再聊)(?:刚才|之前|前面)?(?:的)?([^，。！？?\n]{2,80})/gu),match=>match[1])
    .filter(name=>!pureDeictic(name))
    .map(name=>compact(name.replace(/^(?:这|那)(?:一)?(?:张|幅|篇|份)/u,'').split(/(?:这|那)(?:一)?(?:页|篇|份)|里面|里边|的|怎么|如何|为什么|讲了|说了/u)[0]))
    .filter(name=>name.length>=2&&!genericTitles.has(name));
}

function deicticRequest(text){
  return /(?:刚才|之前|前面|上一)(?:那|这|的)?(?:一)?(?:页|篇|份|个网页|个页面|篇文章)|(?:这|那)(?:一)?(?:页|篇文章|份资料|份材料|个网页|个页面)|继续(?:解释|讲解|说明)|\b(?:that page|this page|previous page|continue explaining)\b/iu.test(text);
}

function pureDeictic(text){
  return !String(text).normalize('NFKC').toLowerCase()
    .replace(/\b(?:that page|this page|previous page|continue explaining|please|what does it say|tell me more|explain it)\b/giu,' ')
    .replace(/(?:主要讲了什么|讲了什么|说了什么|有什么内容|怎么理解|为什么这样说|为什么这么说|为什么会这样写|怎么回事|你刚才看的|你刚才读的|刚才|之前|前面|上一|这一|那一|这页|那页|这篇|那篇|这份|那份|篇文章|份资料|份材料|个网页|个页面|网页|页面|文章|资料|材料|继续|解释|讲解|说明|展开|具体|详细|说说|讲讲|告诉|请|能不能|可以|我|你|您|我们|的|一下|一点|再|呢|吗|吧|页|篇|份)/gu,' ')
    .replace(/[^\p{L}\p{N}]/gu,'');
}

/**
 * Resolve already observed public-page material for a current owner turn.
 * No old assistant prose is used as evidence, and no data is written. Explicit
 * URLs deliberately require the current capability loop to read them again.
 */
export function foregroundSourceHistory(agent,{ownerText,admittedIds,now=Date.now()}={}){
  if(!safeId(agent?.id)||typeof ownerText!=='string'||!ownerText.trim()||ownerText.length>16000||!ids(admittedIds,MAX_OWNERS)||!Number.isSafeInteger(now)||now<0)return none('invalid-history-request');
  if(/[a-z][a-z0-9+.-]*:\/\//iu.test(ownerText))return none('explicit-url-needs-current-read');
  if(/(?:先不聊|不想聊|别聊|不聊(?:了|这些|这个|那个)|换个话题|聊点别的)/u.test(ownerText))return none('owner-changed-topic');
  const journal=agent.factory?.journal,db=journal?.db,domain=agent.factory?.domain,id=agent.id;
  if(!db?.prepare)return none('history-unavailable');
  try{
    journal.assertAdmitted?.(id);
    if(db.prepare('SELECT 1 FROM retirement WHERE id=?').get(id))return none('session-retired');
    // The existing forgetting barrier also covers an earlier URL-bearing
    // bubble in a batched owner turn when its last bubble is still active.
    const barrier=typeof journal.value==='function'?journal.value(id,'memoryContextBarrierAt',0):0;
    if(!Number.isSafeInteger(barrier)||barrier<0||barrier>now)return none('invalid-memory-barrier');
    const since=Math.max(0,now-DAY,barrier+1);
    const usable=sourceId=>{
      if(!safeId(sourceId))return false;
      if(typeof domain?.sourceUsable==='function')return domain.sourceUsable(id,sourceId)===true;
      const row=db.prepare('SELECT root,status FROM source_record WHERE agent=? AND id=?').get(id,sourceId);
      return !!row&&row.status==='active'&&!db.prepare('SELECT 1 FROM extraction_block WHERE agent=? AND source=?').get(id,row.root);
    };
    const owners=db.prepare("SELECT seq,event_key,created FROM outbox WHERE agent=? AND kind='user' AND created>=? AND created<=? ORDER BY seq DESC LIMIT ?").all(id,since,now,MAX_OWNERS).map(row=>({...row,ownerId:typeof row.event_key==='string'&&row.event_key.startsWith('user:')?row.event_key.slice(5):null}));
    if(owners.some(row=>!Number.isSafeInteger(row.seq)||!Number.isSafeInteger(row.created)||row.created<since||row.created>now||!safeId(row.ownerId)))return none('owner-history-boundary-unavailable');
    const current=owners.filter(row=>admittedIds.includes(row.ownerId));
    if(current.length!==admittedIds.length||current.some(row=>!usable(row.ownerId)))return none('current-owner-source-unavailable');
    const first=current.reduce((a,b)=>a.seq<b.seq?a:b),previous=owners.find(row=>row.seq<first.seq);
    const rows=db.prepare("SELECT j.id,j.tool,CASE WHEN length(j.input)<=16384 THEN j.input END AS input,CASE WHEN length(j.result)<=131072 THEN j.result END AS result,j.created,j.updated,CASE WHEN length(m.snapshot)<=32768 THEN m.snapshot END AS snapshot,CASE WHEN length(m.prepared)<=131072 THEN m.prepared END AS prepared,m.policy_revision,m.digest,m.task_id FROM human_tool_job j JOIN human_capability_job m ON m.id=j.id AND m.agent=j.agent WHERE j.agent=? AND length(j.id)<=160 AND j.status='completed' AND j.tool IN ('read-public-page','compare-public-page') AND m.origin='owner' AND length(m.task_id)<=64 AND length(m.digest)=64 AND m.task_id GLOB 'foreground:[0-9]*' AND j.created>=? AND j.updated>=j.created AND j.updated<=? ORDER BY j.updated DESC,j.id DESC LIMIT ?").all(id,since,first.created,MAX_JOBS);
    const all=[],latestByUrl=new Map();
    for(const row of rows){
      const input=json(row.input,16384),result=json(row.result,131072),snapshot=json(row.snapshot,32768),prepared=row.prepared===null?null:json(row.prepared,131072);
      if(!Number.isSafeInteger(row.created)||!Number.isSafeInteger(row.updated)||row.created<since||row.updated<row.created||row.updated>first.created||!Number.isSafeInteger(row.policy_revision)||row.policy_revision<0||!/^foreground:\d{1,13}$/u.test(row.task_id)||!plain(input)||!plain(result)||!plain(snapshot)||snapshot.id!==row.tool||snapshot.effect!=='read'||snapshot.scope!=='public-web'||!hex(row.digest)||row.digest!==hash({tool:row.tool,input,snapshot,prepared,policyRevision:row.policy_revision}))continue;
      if(result.truncated===true||result.sourceValid===false||typeof result.title!=='string'||!result.title.trim()||result.title.length>512||typeof result.excerpt!=='string'||!result.excerpt.trim()||result.excerpt.length>32768||!hex(result.digest)||typeof result.partial!=='boolean')continue;
      if(result.fetchedAt!==undefined&&(!Number.isSafeInteger(result.fetchedAt)||result.fetchedAt<since||result.fetchedAt>now))continue;
      let url;try{researchUrl(input.url);url=researchUrl(result.url);}catch{continue;}
      const sourceOwner=db.prepare("SELECT seq,event_key,created FROM outbox WHERE agent=? AND kind='user' AND created<=? ORDER BY created DESC,seq DESC LIMIT 1").get(id,row.created),sourceOwnerId=sourceOwner?.event_key?.startsWith('user:')?sourceOwner.event_key.slice(5):null;
      if(!sourceOwner||sourceOwner.created<=barrier||!usable(sourceOwnerId)||admittedIds.includes(sourceOwnerId))continue;
      const material={jobId:row.id,url,title:result.title,digest:result.digest,excerpt:result.excerpt,partial:result.partial,reused:true},entry={material,created:row.created,updated:row.updated,ownerId:sourceOwnerId};
      all.push(entry);if(!latestByUrl.has(url))latestByUrl.set(url,entry);
    }
    const latest=[...latestByUrl.values()],titles=namedTargets(ownerText);
    const named=titles.length?latest.filter(entry=>titles.every(title=>compact(entry.material.title).includes(title))):latest.filter(entry=>titleMatch(entry.material.title,ownerText));
    if(titles.length>1&&titles.every(title=>latest.some(entry=>compact(entry.material.title).includes(title))))return ambiguous('multiple-named-sources');
    if(titles.length&&!named.length)return none('named-source-not-found');
    if(named.length===1)return {materials:[named[0].material],mode:'named'};
    if(named.length>1)return ambiguous('multiple-named-sources');
    if(!deicticRequest(ownerText))return none('not-a-source-reference');
    // A substantive question may still explicitly point at the unique page
    // in the preceding committed turn. Binding the page does not prove that
    // its observed excerpt supports the question; the selector checks that.
    if(!previous||!usable(previous.ownerId))return ambiguous('previous-owner-source-unavailable');
    const replies=db.prepare("SELECT seq,created FROM outbox WHERE agent=? AND kind='assistant' AND seq>? AND seq<? AND created>=? AND created<=? ORDER BY seq DESC LIMIT 2").all(id,previous.seq,first.seq,previous.created,first.created);
    if(replies.length!==1)return ambiguous('previous-source-reply-not-unique');
    const reply=replies[0],audits=db.prepare("SELECT seq,CASE WHEN length(data)<=16384 THEN data END AS data FROM audit WHERE agent=? AND kind='foreground-source-rendered' ORDER BY seq DESC LIMIT ?").all(id,MAX_AUDITS),rendered=[];
    for(const row of audits){
      const data=json(row.data,16384);
      if(!plain(data)||!Number.isSafeInteger(data.time)||data.time<since||data.time<previous.created||data.time>reply.created)continue;
      if(!ids(data.ownerMessageIds,MAX_OWNERS))return none('render-owner-source-unavailable');
      if(!data.ownerMessageIds.includes(previous.ownerId))continue;
      const valid=data.ownerMessageIds.every(ownerId=>!admittedIds.includes(ownerId)&&usable(ownerId))&&ids(data.jobIds,MAX_JOBS)&&hex(data.catalogHash),entries=valid?data.jobIds.map(jobId=>all.find(entry=>entry.material.jobId===jobId)):[];
      rendered.push({time:data.time,seq:row.seq,valid:valid&&entries.every(entry=>entry&&entry.updated<=data.time),entries});
    }
    rendered.sort((a,b)=>b.time-a.time||b.seq-a.seq);
    if(rendered[0]&&!rendered[0].valid)return ambiguous('rendered-source-unavailable');
    const visible=rendered[0]?.entries??all.filter(entry=>entry.ownerId===previous.ownerId&&entry.created>=previous.created&&entry.updated<=reply.created);
    const visibleByUrl=new Map();for(const entry of visible)if(!visibleByUrl.has(entry.material.url))visibleByUrl.set(entry.material.url,entry);
    if(visibleByUrl.size!==1)return ambiguous('previous-turn-has-no-unique-source');
    return {materials:[[...visibleByUrl.values()][0].material],mode:'deictic'};
  }catch{return none('history-boundary-unavailable');}
}
