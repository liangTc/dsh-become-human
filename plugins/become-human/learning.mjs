import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {lexicalCoverage,sourceSignals,retrievalTerms,questionSignals} from './knowledge-signals.mjs';
import {resolvePublicAddresses} from './public-dns.mjs';

// Open public web research. Domain and subject are not allowlisted. Every hop is
// pinned to a public DNS address; no browser cookies, credentials or JS execution.
export function researchUrl(value){
  if(typeof value!=='string'||value.length>2400)throw new Error('SOURCE_URL_NOT_ALLOWED');
  let u;try{u=new URL(value);}catch{throw new Error('SOURCE_URL_NOT_ALLOWED');}
  const host=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!host.includes('.')&&!net.isIP(host)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||net.isIP(host)&&!publicAddress(host)||[...u.searchParams.keys()].some(k=>/^(?:access[_-]?token|token|api[_-]?key|password|secret|authorization|signature)$/i.test(k)))throw new Error('SOURCE_URL_NOT_ALLOWED');
  u.hash='';if(u.href.length>2400)throw new Error('SOURCE_URL_NOT_ALLOWED');return u.href;
}
export function publicAddress(address){
  if(net.isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2))||a===100&&b>=64&&b<=127||a>=224||a===198&&([18,19].includes(b)||b===51&&c===100)||a===203&&b===0&&c===113);}
  // Restrict IPv6 to global unicast. IPv4-mapped and local addresses are excluded.
  return net.isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:0{0,3}[0-9a-f]{1,2}|db8):|^2002:/i.test(address);
}
function decode(text){return text.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x]));}
function decodeBody(chunks,type){try{return new TextDecoder(/charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]??'utf-8').decode(Buffer.concat(chunks));}catch{return Buffer.concat(chunks).toString('utf8');}}
function contentFragment(html){
  const candidates=[];
  for(const opening of html.matchAll(/<(article|main|div|section)\b([^>]*)>/gi)){
    const tag=opening[1].toLowerCase(),attrs=opening[2];
    if(/\bhidden\b|aria-hidden\s*=\s*["']true|display\s*:\s*none/i.test(attrs)||/\b(?:nav|menu|sidebar|footer|header|related)[-_\s]/i.test(attrs))continue;
    const rank=/articlebody|trs[_ -]?(?:editor|ueditor)|(?:article|post|entry)[-_ ](?:body|content|text)/i.test(attrs)?4:tag==='article'?3:tag==='main'?2:/\b(?:id|class)\s*=\s*["'][^"']*content/i.test(attrs)?1:0;
    if(!rank)continue;
    const endTag=new RegExp('<\\/?'+tag+'\\b[^>]*>','gi');endTag.lastIndex=opening.index+opening[0].length;let depth=1,end;
    for(let next;(next=endTag.exec(html));){depth+=next[0].startsWith('</')?-1:next[0].endsWith('/>')?0:1;if(!depth){end=next.index;break;}}
    if(end!==undefined){const body=html.slice(opening.index+opening[0].length,end),chars=body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().length;candidates.push({rank,body,chars});}
    if(candidates.length>=40)break;
  }
  return candidates.filter(x=>x.chars>=100).sort((a,b)=>b.rank-a.rank||b.chars-a.chars)[0]?.body??html;
}
export function sourceText(text,type){
  if(/html|xml/.test(type)){text=text.replace(/<(script|style|nav|aside|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<(script|style)\b[^>]*>[\s\S]*$/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');if(type.includes('html'))text=contentFragment(text);text=text.replace(/<[^>]+>/g,' ');}
  return decode(text).replace(/\s+/g,' ').trim();
}
// Pick one contiguous slice of the observed body, never a generated summary or
// search snippet. A later relevant paragraph can otherwise be lost behind a
// long page introduction. No match keeps the original leading-window behavior.
export function researchExcerpt(text,topic,{maxChars=2800}={}){
  if(typeof text!=='string'||typeof topic!=='string'||!Number.isInteger(maxChars)||maxChars<100||maxChars>2800)throw new Error('INVALID_RESEARCH_EXCERPT');
  const stop=new Set(['the','and','for','with','from','what','how','are','this','that','into','about','using','latest','recent','一个','什么','如何','哪些','最新','研究','资料','问题','了解','相关','学习','是否','以及','可以','进行','方向','内容','来源']);
  const identifiers=new Set(questionSignals(topic).identifiers),terms=[...new Set([...identifiers,...retrievalTerms(topic,{limit:32})].filter(t=>!stop.has(t)&&(!/^\d+$/.test(t)||identifiers.has(t))))].slice(0,32);
  // NFKC can change offsets (for example a ligature). Match on the original
  // lowercase body so every selected offset still addresses exact source text.
  const observed=text.replace(/[A-Z]/g,char=>char.toLowerCase()),candidates=new Set([0]);
  const boundary=start=>{
    start=Math.max(0,Math.min(start,Math.max(0,text.length-maxChars)));
    if(!start)return 0;
    const nearby=text.slice(Math.max(0,start-180),start),last=[...nearby.matchAll(/[。！？!?\n]|\.(?=\s)/gu)].at(-1);
    return last?Math.max(0,start-180)+last.index+last[0].length:start;
  };
  for(const term of terms){let at=0;for(let n=0;n<24;n++){at=observed.indexOf(term,at);if(at<0)break;candidates.add(boundary(at-Math.floor(maxChars/5)));candidates.add(boundary(at-maxChars+180));at+=term.length;}}
  const score=start=>{const slice=observed.slice(start,start+maxChars);let value=0;for(const term of terms){let at=0,count=0;const numeric=/^\d+$/u.test(term);while(count<3&&(at=slice.indexOf(term,at))>=0){const found=at;at+=term.length;if(numeric&&(/[a-z0-9]/u.test(slice[found-1]??'')||/[a-z0-9]/u.test(slice[at]??'')))continue;count++;}if(count)value+=(4+count)*(identifiers.has(term)?numeric?8:4:1);}return value;};
  let start=0,best=score(0);for(const candidate of candidates){const value=score(candidate);if(value>best||value===best&&candidate<start){start=candidate;best=value;}}
  // Keep selection bounded to an exact slice even when a query used fullwidth
  // characters. Query normalization may help term matching; offsets never use it.
  const excerpt=text.slice(start,start+maxChars);
  return {excerpt,start,end:start+excerpt.length,selection:start?'query-window':'leading-window'};
}
async function requestText(url,signal){
  signal.throwIfAborted();
  const u=new URL(researchUrl(url));
  const addresses=await resolvePublicAddresses(u.hostname,{signal,isPublic:publicAddress});signal.throwIfAborted();
  if(!addresses.length||addresses.some(x=>!publicAddress(x.address)))throw new Error('SOURCE_ADDRESS_NOT_PUBLIC');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    let response,done=false,total=0;const chunks=[];
    const complete=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const request=(u.protocol==='https:'?https:http).request(u,{method:'GET',agent:false,lookup:(_host,options,callback)=>options?.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family),headers:{'User-Agent':'BecomeHumanResearch/0.5','Accept':'text/html,text/plain,application/json,application/xml,application/rss+xml,application/atom+xml','Accept-Encoding':'identity'}},res=>{
      response=res;
      if([301,302,303,307,308].includes(res.statusCode)){let redirect;try{if(!res.headers.location)throw new Error();redirect=researchUrl(new URL(res.headers.location,u).href);}catch{res.destroy();complete(new Error('SOURCE_URL_NOT_ALLOWED'));return;}res.destroy();complete(null,{redirect});return;}
      const type=String(res.headers['content-type']??'').toLowerCase();
      if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||!['text/html','text/plain','text/markdown','text/xml','application/json','application/xml','application/rss+xml','application/atom+xml'].some(t=>type.startsWith(t))){res.destroy();complete(new Error(res.statusCode===429?'SOURCE_RATE_LIMITED':'SOURCE_RESPONSE_UNSUPPORTED'));return;}
      res.on('data',chunk=>{const remaining=2097152-total;total+=chunk.length;if(total>2097152){if(remaining>0)chunks.push(chunk.subarray(0,remaining));complete(null,{type,body:decodeBody(chunks,type),truncated:true});request.destroy();res.destroy();}else chunks.push(chunk);});
      res.on('error',()=>complete(new Error('SOURCE_CONNECTION_FAILED')));
      res.on('end',()=>complete(null,{type,body:decodeBody(chunks,type),truncated:false}));
    });
    const abort=()=>{request.destroy();response?.destroy();complete(signal.reason??new Error('SOURCE_CANCELLED'));};
    signal.addEventListener('abort',abort,{once:true});request.on('error',()=>complete(new Error('SOURCE_CONNECTION_FAILED')));request.end();
    if(signal.aborted)abort();
  });
}
export async function fetchPublicDocument(input,signal){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(20000)]);let url=researchUrl(input),result;
  try{for(let i=0;i<4;i++){result=await requestText(url,combined);combined.throwIfAborted();if(!result.redirect)break;url=researchUrl(result.redirect);if(i===3)throw new Error('SOURCE_REDIRECT_LIMIT');}}
  catch(error){if(signal.aborted)throw signal.reason??error;if(combined.aborted)throw new Error('SOURCE_TIMEOUT');if(['ENOTFOUND','EAI_AGAIN'].includes(error.code))throw new Error('SOURCE_DNS_FAILED');throw error;}
  return {...result,url,fetchedAt:Date.now()};
}
function pageMetadata(body,type){
  if(!type.includes('html'))return {};
  const title=sourceText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]??'','text/html').slice(0,100);
  let publishedAt=null;
  for(const tag of body.match(/<meta\b[^>]*>/gi)??[]){const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),decode(m[3])]));if(/^(?:article:published_time|datePublished|date)$/i.test(attrs.property??attrs.name??'')&&attrs.content?.length<=100&&Number.isFinite(Date.parse(attrs.content))){publishedAt=new Date(attrs.content).toISOString();break;}}
  return {title,publishedAt,publishedAtStatus:publishedAt?'publisher-reported':'unknown'};
}
export async function fetchResearch(source,signal){
  if(researchUrl(source.url).length>1200)throw new Error('SOURCE_URL_TOO_LONG');
  const result=await fetchPublicDocument(source.url,signal),{url}=result;
  if(url.length>1200)throw new Error('SOURCE_URL_TOO_LONG');
  const text=sourceText(result.body,result.type);if(text.length<100)throw new Error('SOURCE_CONTENT_TOO_SHORT');
  let maxChars=2800,selection=researchExcerpt(text,String(source.topic??source.title??''),{maxChars});
  while(JSON.stringify({url,excerpt:selection.excerpt,digest:'0'.repeat(64),fetchedAt:Date.now()}).length>3800&&maxChars>100){maxChars-=100;selection=researchExcerpt(text,String(source.topic??source.title??''),{maxChars});}
  const {excerpt}=selection;
  const metadata=pageMetadata(result.body,result.type);
  return {url,title:metadata.title||source.title,topic:source.topic,excerpt,excerptOffset:selection.start,excerptSelection:selection.selection,digest:createHash('sha256').update(text).digest('hex'),digestScope:'observed-extracted-text',fetchedAt:result.fetchedAt,partial:!!result.truncated||text.length>excerpt.length,transportTruncated:!!result.truncated,publishedAt:metadata.publishedAt??null,publishedAtStatus:metadata.publishedAtStatus??'unknown',signals:sourceSignals({url,title:metadata.title||source.title}),...(source.discovery?{discovery:source.discovery}:{})};
}
const outputError=(code,field,reason,extra={})=>Object.assign(new Error(code),{validationDiagnostic:{field,reason,...extra}});
const valueType=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
export function requireOutputText(value,field,max,{code='INVALID_TASK_OUTPUT'}={}){
  const text=value?.[field];
  if(typeof text!=='string')throw outputError(code,field,text===undefined?'required-field-missing':'invalid-field-type',{actualType:valueType(text),expectedType:'string'});
  if(!text.trim())throw outputError(code,field,'empty-string',{length:text.length,maximum:max});
  if(text.length>max)throw outputError(code,field,'field-too-long',{length:text.length,maximum:max});
  return text;
}
// All rejected output paths share a bounded diagnostic envelope. Never retain
// the output, unexpected field names, supplied identifiers or free-form errors.
export function outputDiagnostic(error,{phase='unknown',text='',source=null}={}){
  const knownPhases=new Set(['selection','execution','learning','unknown']),d=error?.validationDiagnostic??{},format=error?.formatDiagnostic;
  const safe={},numeric=['length','maximum','providedCount','allowedCount','unknownCount','unsupportedCount','unexpectedFieldCount','claimIndex','textLength'];
  for(const field of ['field','reason','actualType','expectedType'])if(typeof d[field]==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/u.test(d[field]))safe[field]=d[field];
  for(const field of numeric)if(Number.isFinite(d[field])&&d[field]>=0)safe[field]=d[field];
  const output={version:1,phase:knownPhases.has(phase)?phase:'unknown',code:/^[A-Z_]{3,64}$/u.test(error?.message??'')?error.message:'OUTPUT_VALIDATION_FAILED',textChars:typeof text==='string'?text.length:0,...safe};
  if(format)output.format=Object.fromEntries(['unquotedKey','singleQuotedKey','startsWithObject','endsWithObject'].map(k=>[k,format[k]===true]));
  if(!output.reason)output.reason=output.code==='INVALID_TASK_OUTPUT'?'output-contract-mismatch':output.code.toLowerCase().replaceAll('_','-');
  if(source)output.evidence={availableUnits:typeof source.excerpt==='string'?evidenceUnits(source).length:0,sourcePartial:!!source.partial,semanticVerified:false};
  output.nextAction=output.reason==='invalid-json'?'inspect-json-format':output.code.startsWith('UNSUPPORTED_LEARNING')?'inspect-source-and-claim-evidence':output.code==='UNSUPPORTED_OWNER_SOURCE'?'inspect-owner-evidence-links':'inspect-output-contract';
  return output;
}
export function structured(text){
  if(typeof text!=='string')throw outputError('INVALID_TASK_OUTPUT','output','invalid-field-type',{actualType:valueType(text),expectedType:'string'});
  const trimmed=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');let value;
  try{value=JSON.parse(trimmed);}catch{throw Object.assign(outputError('INVALID_TASK_OUTPUT','output','invalid-json'),{formatDiagnostic:{unquotedKey:/(?:^|[{,])\s*[A-Za-z_][\w-]*\s*:/u.test(trimmed),singleQuotedKey:/(?:^|[{,])\s*'[^']+'\s*:/u.test(trimmed),startsWithObject:trimmed.startsWith('{'),endsWithObject:trimmed.endsWith('}')}});}
  if(!value||typeof value!=='object'||Array.isArray(value))throw outputError('INVALID_TASK_OUTPUT','output','object-required',{actualType:valueType(value),expectedType:'object'});return value;
}
// Conservative checks for historical owner-position claims in autonomous technical output.
// This is a bounded guard for known wording, not a general semantic truth verifier.
export function ownerAttributionRisk(text){
  return [
    /(?:你|您)(?:那条|这条|提的|提出的|提到的|说过|说的|告诉过我|认为|同意|认可)/u,
    /(?:你|您)(?:之前|刚才|曾经|已经|明确).{0,10}(?:提出|提到|说|喜欢|选择|同意|希望|要求)/u,
    /(?:你|您)的(?:观点|立场|建议|思路|决定|说法)/u,
    /我(?:记得|知道)(?:你|您)(?:曾|之前|喜欢|希望|认为|选择)/u,
    /\byou\s+(?:said|suggested|proposed|told|agreed|prefer|chose|believe)\b/i,
    /\byour\s+(?:proposal|position|view|suggestion|idea|choice)\b/i,
  ].some(pattern=>pattern.test(text));
}
export function assertAgentPerspective(text){if(ownerAttributionRisk(text))throw new Error('UNSUPPORTED_OWNER_ATTRIBUTION');}
// Digital feelings and preferences remain allowed. These patterns only reject
// known unsupported first-person physical/recovery claims, not all inventions.
export function agentExperienceIssue(text){
  const rules=[
    ['first-person-physical',/我(?:自己|最近|今天|昨天|刚才|刚刚|昨晚|上次|这几天)?[^你您他她它。！？?\n，,；;]{0,14}(?:吃了|喝了|去过|去了|睡了|睡醒|身体[^你您他她它。！？?\n，,；;]{0,4}(?:累|疼)|累[^你您他她它。！？?\n，,；;]{0,5}(?:恢复|缓过|散了))/u],
    ['unattributed-recovery',/(?:^|[。！？?\n，—])\s*上次(?:那点|的)?(?:累|疲惫|疲劳)[^你您他她它。！？?\n，,；;]{0,10}(?:散|缓|恢复|好多了)/u],
    ['english-first-person-physical',/\bI\s+(?:slept|ate|drank|visited|recovered from)\b/i],
  ];
  for(const [rule,pattern] of rules){const match=pattern.exec(text);if(match)return {rule,start:match.index,length:match[0].length,matchHash:createHash('sha256').update(match[0]).digest('hex')};}
  return null;
}
export function agentExperienceRisk(text){return !!agentExperienceIssue(text);}
// Care is an owner-facing check-in, not a source-analysis task. Known source
// attribution forms need the separate, evidence-carrying learning/share lane.
export function careKnowledgeRisk(text){return /(?:资料|材料|文章|论文|研究|报告|来源|文献|官网|网页|笔记)[^。！？?\n]{0,24}(?:提到|指出|显示|证明|表明|认为|建议|说|结论|发现)|(?:根据|依据|参考)[^。！？?\n]{0,16}(?:研究|文献|材料|资料|文章|报告)/u.test(text);}
export function careResult(text,ownerSourceIds=[]){
  return ownerFacingResult(text,ownerSourceIds,true);
}
export function chatResult(text,ownerSourceIds=[]){
  return ownerFacingResult(text,ownerSourceIds,false);
}
function ownerFacingResult(text,ownerSourceIds,requireQuestion){
  if(text.trim()==='[WAIT]')return '[WAIT]';
  const value=structured(text),allowed=new Set(ownerSourceIds);
  const code=requireQuestion?'INVALID_CARE_OUTPUT':'INVALID_CHAT_OUTPUT',unexpected=Object.keys(value).filter(k=>!['text','perspective','ownerSourceIds'].includes(k));
  if(unexpected.length)throw outputError(code,'output','unexpected-fields',{unexpectedFieldCount:unexpected.length});
  if(value.perspective!=='agent-to-owner')throw outputError(code,'perspective',value.perspective===undefined?'required-field-missing':'invalid-enum-value',{actualType:valueType(value.perspective)});
  requireOutputText(value,'text',600,{code});
  if(requireQuestion&&!/[？?]/u.test(value.text))throw outputError(code,'text','question-required');
  if(!Array.isArray(value.ownerSourceIds)||value.ownerSourceIds.length>4||new Set(value.ownerSourceIds).size!==value.ownerSourceIds.length)throw outputError(code,'ownerSourceIds',!Array.isArray(value.ownerSourceIds)?'array-required':'invalid-reference-count',{actualType:valueType(value.ownerSourceIds),providedCount:Array.isArray(value.ownerSourceIds)?value.ownerSourceIds.length:0,maximum:4});
  const unknownCount=value.ownerSourceIds.filter(id=>typeof id!=='string'||!allowed.has(id)).length;
  if(unknownCount)throw Object.assign(new Error('UNSUPPORTED_OWNER_SOURCE'),{validationDiagnostic:{field:'ownerSourceIds',reason:'outside-request-evidence',providedCount:value.ownerSourceIds.length,allowedCount:allowed.size,unknownCount}});
  if(ownerAttributionRisk(value.text)&&!value.ownerSourceIds.length)throw Object.assign(new Error('UNSUPPORTED_OWNER_SOURCE'),{validationDiagnostic:{field:'ownerSourceIds',reason:'missing-owner-evidence',providedCount:0,allowedCount:allowed.size,unknownCount:0}});
  if(careKnowledgeRisk(value.text))throw new Error('UNSUPPORTED_CARE_KNOWLEDGE');
  const issue=agentExperienceIssue(value.text);if(issue)throw Object.assign(new Error('UNSUPPORTED_AGENT_EXPERIENCE'),{validationDiagnostic:{field:'text',...issue}});
  return value.text.trim();
}
export function insightResult(text,{evidenceIds=[]}={}){
  if(text.trim()==='[WAIT]')return '[WAIT]';
  const value=structured(text);
  const unexpected=Object.keys(value).filter(k=>!['text','perspective'].includes(k));
  if(unexpected.length)throw outputError('INVALID_PROACTIVE_OUTPUT','output','unexpected-fields',{unexpectedFieldCount:unexpected.length});
  if(value.perspective!=='agent-proposal')throw outputError('INVALID_PROACTIVE_OUTPUT','perspective',value.perspective===undefined?'required-field-missing':'invalid-enum-value',{actualType:valueType(value.perspective)});
  requireOutputText(value,'text',1200,{code:'INVALID_PROACTIVE_OUTPUT'});
  assertAgentPerspective(value.text);
  const references=new Set(evidenceIds.filter(id=>typeof id==='string'&&/^E[1-9]\d*$/.test(id)));
  if([...value.text.matchAll(/\bE[1-9]\d*\b/gu)].some(match=>references.has(match[0])))throw Object.assign(new Error('INTERNAL_EVIDENCE_REFERENCE'),{validationDiagnostic:{field:'text',internalReference:true}});
  return value.text.trim();
}
export function evidenceUnits(source){
  if(typeof source?.excerpt!=='string')throw new Error('INVALID_LEARNING_SOURCE');
  const units=[],text=source.excerpt;
  for(let offset=0;offset<text.length;){
    let end=Math.min(offset+240,text.length);
    if(end<text.length){const punctuation=[...text.slice(offset,end).matchAll(/[。！？!?\n]|\.(?=\s)/gu)].at(-1);if(punctuation&&punctuation.index>=80)end=offset+punctuation.index+1;}
    const start=end-offset<8?Math.max(0,end-8):offset;
    units.push({id:'E'+(units.length+1),quote:text.slice(start,end),start,end});offset=end;
  }
  return units;
}
function assertClaimEvidence(text,quote){
  const normalized=value=>value.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g,'').replace(/\s+/g,' ').trim();
  const observed=normalized(quote),numbers=new Set(observed.match(/\d+(?:\.\d+)?/g)??[]);
  const unsupportedNumbers=(normalized(text).match(/\d+(?:\.\d+)?/g)??[]).filter(number=>!numbers.has(number));
  if(unsupportedNumbers.length)throw Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE'),{validationDiagnostic:{field:'claims.text',reason:'number-outside-evidence',unsupportedCount:unsupportedNumbers.length}});
  for(const match of text.matchAll(/[“"]([^”"\n]{8,120})[”"]/gu))if(!observed.toLowerCase().includes(normalized(match[1]).toLowerCase()))throw Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE'),{validationDiagnostic:{field:'claims.text',reason:'quotation-outside-evidence',unsupportedCount:1}});
}
function evidenceError(reason,providedCount,allowedCount){
  return Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE'),{validationDiagnostic:{field:'claims.evidenceIds',reason,providedCount,allowedCount}});
}
// Normalize only explicit E identifiers. These are formatting-equivalent
// references, not model repair: bare numbers, ranges and unknown IDs never gain
// evidence. Canonical order is safe because the same exact contiguous span is
// bound below, independently of the order in which it was cited.
export function normalizeEvidenceReferences(value,units,{singular=false}={}){
  let raw=value;
  if(typeof raw==='string'){
    if(raw.length>120)throw evidenceError('invalid-reference-format',null,units.length);
    raw=raw.normalize('NFKC').trim();
    if(raw.startsWith('[')&&raw.endsWith(']'))raw=raw.slice(1,-1).trim();
    raw=raw.split(/[,、]/u);
  }
  if(!Array.isArray(raw)||!raw.length||raw.length>3||singular&&raw.length!==1)throw evidenceError('invalid-reference-count',Array.isArray(raw)?raw.length:null,units.length);
  const ids=raw.map(id=>{
    if(typeof id!=='string'||id.length>40)throw evidenceError('invalid-reference-format',raw.length,units.length);
    let normalized=id.normalize('NFKC').trim();if(normalized.startsWith('[')&&normalized.endsWith(']'))normalized=normalized.slice(1,-1).trim();
    const match=/^E\s*([1-9]\d{0,4})$/iu.exec(normalized);
    if(!match)throw evidenceError('invalid-reference-format',raw.length,units.length);
    return 'E'+match[1];
  });
  if(new Set(ids).size!==ids.length)throw evidenceError('duplicate-reference',ids.length,units.length);
  const evidence=new Map(units.map((unit,index)=>[unit.id,{...unit,index}]));
  if(ids.some(id=>!evidence.has(id)))throw evidenceError('outside-source-evidence',ids.length,units.length);
  ids.sort((a,b)=>evidence.get(a).index-evidence.get(b).index);
  if(ids.some((id,index)=>index>0&&evidence.get(id).index!==evidence.get(ids[index-1]).index+1))throw evidenceError('non-contiguous-reference',ids.length,units.length);
  return ids;
}
export function learningResult(text,source){
  const value=structured(text),keys=['title','summary','claims','relevance','question','share','evidenceStatus'];
  if(value.evidenceStatus==='insufficient'){
    const unexpected=Object.keys(value).filter(k=>!['evidenceStatus','reason'].includes(k));
    if(unexpected.length)throw outputError('INVALID_TASK_OUTPUT','output','unexpected-fields',{unexpectedFieldCount:unexpected.length});
    requireOutputText(value,'reason',300);
    return value;
  }
  if(value.evidenceStatus!==undefined&&value.evidenceStatus!=='sufficient'||source.discovery&&value.evidenceStatus!=='sufficient')throw outputError('INVALID_TASK_OUTPUT','evidenceStatus',value.evidenceStatus===undefined?'required-field-missing':'invalid-enum-value',{actualType:valueType(value.evidenceStatus)});
  const unexpected=Object.keys(value).filter(k=>!keys.includes(k));if(unexpected.length)throw outputError('INVALID_TASK_OUTPUT','output','unexpected-fields',{unexpectedFieldCount:unexpected.length});
  for(const k of ['title','summary','relevance','question','share'])requireOutputText(value,k,({title:100,summary:800,relevance:400,question:240,share:600}[k]));
  try{assertAgentPerspective(value.share);}catch(error){
    if(error.message==='UNSUPPORTED_OWNER_ATTRIBUTION')error.validationDiagnostic={field:'share',reason:'owner-attribution-in-autonomous-learning'};
    throw error;
  }
  if(!Array.isArray(value.claims)||!value.claims.length||value.claims.length>4)throw outputError('INVALID_LEARNING_CLAIM_COUNT','claims',!Array.isArray(value.claims)?'array-required':'claim-count-out-of-range',{actualType:valueType(value.claims),providedCount:Array.isArray(value.claims)?value.claims.length:0,maximum:4});
  const units=evidenceUnits(source),evidence=new Map(units.map((u,index)=>[u.id,{...u,index}]));
  value.claims=value.claims.map((c,claimIndex)=>{
    try{requireOutputText(c,'text',400,{code:'INVALID_LEARNING_CLAIM_TEXT'});}catch(error){error.validationDiagnostic.claimIndex=claimIndex;error.validationDiagnostic.field='claims.text';throw error;}
    if(Object.hasOwn(c,'evidenceId')||Object.hasOwn(c,'evidenceIds')){
      if(Object.hasOwn(c,'evidenceId')&&Object.hasOwn(c,'evidenceIds'))throw evidenceError('ambiguous-reference-fields',null,units.length);
      if(Object.keys(c).some(k=>!['text','evidenceId','evidenceIds'].includes(k)))throw evidenceError('unexpected-reference-field',null,units.length);
      const singular=Object.hasOwn(c,'evidenceId'),ids=normalizeEvidenceReferences(singular?c.evidenceId:c.evidenceIds,units,{singular});
      const selected=ids.map(id=>evidence.get(id));
      const quote=source.excerpt.slice(selected[0].start,selected.at(-1).end);assertClaimEvidence(c.text,quote);
      return {text:c.text,quote,evidenceIds:ids};
    }
    if(Object.keys(c).some(k=>!['text','quote'].includes(k)))throw outputError('UNSUPPORTED_LEARNING_CLAIM','claims','unexpected-claim-fields',{claimIndex,unexpectedFieldCount:Object.keys(c).filter(k=>!['text','quote'].includes(k)).length});
    if(typeof c.quote!=='string'||c.quote.length<8||c.quote.length>200||!source.excerpt.includes(c.quote))throw outputError('UNSUPPORTED_LEARNING_CLAIM','claims.quote',typeof c.quote!=='string'?'quote-string-required':c.quote.length<8||c.quote.length>200?'quote-length-out-of-range':'quote-outside-source',{claimIndex,length:typeof c.quote==='string'?c.quote.length:0,maximum:200});
    assertClaimEvidence(c.text,c.quote);return c;
  });
  // Quotes prove traceability, not that every model interpretation is correct.
  return value;
}

export function learningCoverage(result,source,researchQuestion=source?.topic??''){
  const claims=Array.isArray(result?.claims)?result.claims:[],signals=source?.signals??sourceSignals(source),evidence=new Set(claims.flatMap(c=>c.evidenceIds??[]));
  return {version:1,researchQuestion:String(researchQuestion).slice(0,240),status:'source-linked-partial',supportedClaimCount:claims.length,evidenceCount:evidence.size||claims.filter(c=>typeof c.quote==='string').length,sourceCount:1,semanticVerified:false,lexicalQuestionCoverage:lexicalCoverage(researchQuestion,claims.map(c=>c.text+' '+(c.quote??'')).join(' ')),sourceType:signals.type,sourceSignals:signals,scope:'Traceable interpretation of one observed source; question coverage, independent agreement and real-world effect are not established.'};
}
