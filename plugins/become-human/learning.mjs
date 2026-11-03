import {sourceProjection,sourceText,pageMetadata} from './public-text.mjs';
export {sourceText} from './public-text.mjs';
import {createHash} from 'node:crypto';
import {lexicalCoverage,sourceSignals,retrievalTerms,questionSignals} from './knowledge-signals.mjs';
import {researchUrl,fetchPublicDocument} from './public-document.mjs';
export {researchUrl,publicAddress,fetchPublicDocument,sourceFailureDiagnostic} from './public-document.mjs';
import {evidenceScope,assertScopedInterpretation,selectedSourceText,observedSourceTitle,claimTextProjection} from './learning-scope.mjs';
export {evidenceScope,claimTextProjection} from './learning-scope.mjs';

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
    if(last)return Math.max(0,start-180)+last.index+last[0].length;
    // No nearby sentence boundary: advance past a clipped word instead of
    // presenting a tail such as "nt includes" as the start of source evidence.
    if(start&&/[\p{L}\p{N}_]/u.test(text[start-1])&&/[\p{L}\p{N}_]/u.test(text[start]??'')){
      const next=/\s/u.exec(text.slice(start,start+180));if(next)start+=next.index+1;
    }
    return start;
  };
  for(const term of terms){let at=0;for(let n=0;n<24;n++){at=observed.indexOf(term,at);if(at<0)break;candidates.add(boundary(at-Math.floor(maxChars/5)));candidates.add(boundary(at-maxChars+180));at+=term.length;}}
  const score=start=>{const slice=observed.slice(start,start+maxChars);let value=0;for(const term of terms){let at=0,count=0;const numeric=/^\d+$/u.test(term);while(count<3&&(at=slice.indexOf(term,at))>=0){const found=at;at+=term.length;if(/^[a-z0-9_.+#-]+$/u.test(term)&&(/[a-z0-9_]/u.test(slice[found-1]??'')||/[a-z0-9_]/u.test(slice[at]??'')))continue;count++;}if(count)value+=(4+count)*(identifiers.has(term)?numeric?8:4:1);}for(let n=0;n<terms.length-1;n++){const pair=terms[n]+' '+terms[n+1];if(slice.includes(pair))value+=3;}return value;};
  let start=0,best=score(0);for(const candidate of candidates){const value=score(candidate);if(value>best||value===best&&candidate<start){start=candidate;best=value;}}
  // Keep selection bounded to an exact slice even when a query used fullwidth
  // characters. Query normalization may help term matching; offsets never use it.
  let end=Math.min(text.length,start+maxChars);
  if(end<text.length){
    const window=text.slice(start,end),sentence=[...window.matchAll(/[。！？?]|!(?=\s|$)|\.(?=\s|$)/gu)].at(-1);
    if(sentence&&sentence.index>=maxChars/2)end=start+sentence.index+1;
    else if(/[\p{L}\p{N}_]/u.test(text[end-1])&&/[\p{L}\p{N}_]/u.test(text[end]??'')){const gap=window.lastIndexOf(' ');if(gap>=maxChars*.6)end=start+gap;}
  }
  const excerpt=text.slice(start,end);
  return {excerpt,start,end:start+excerpt.length,selection:start?'query-window':'leading-window'};
}
export async function fetchResearch(source,signal){
  if(researchUrl(source.url).length>1200)throw new Error('SOURCE_URL_TOO_LONG');
  const result=await fetchPublicDocument(source.url,signal),{url}=result;
  if(url.length>1200)throw new Error('SOURCE_URL_TOO_LONG');
  const observed=new URL(url),projection=sourceProjection(result.body,result.type,{fragment:observed.hash,markdown:/\.md(?:own)?$/iu.test(observed.pathname)}),text=projection.text;if(text.length<100)throw new Error('SOURCE_CONTENT_TOO_SHORT');
  let maxChars=2800,selection=researchExcerpt(text,String(source.topic??source.title??''),{maxChars});
  while(JSON.stringify({url,excerpt:selection.excerpt,digest:'0'.repeat(64),fetchedAt:Date.now()}).length>3800&&maxChars>100){maxChars-=100;selection=researchExcerpt(text,String(source.topic??source.title??''),{maxChars});}
  const {excerpt}=selection;
  const metadata=pageMetadata(result.body,result.type);
  return {url,title:metadata.title||source.title,topic:source.topic,excerpt,excerptOffset:selection.start,excerptSelection:selection.selection,contentScope:projection.scope,digest:createHash('sha256').update(text).digest('hex'),digestScope:'observed-extracted-text',fetchedAt:result.fetchedAt,partial:!!result.truncated||text.length>excerpt.length,transportTruncated:!!result.truncated,publishedAt:metadata.publishedAt??null,publishedAtStatus:metadata.publishedAtStatus??'unknown',signals:sourceSignals({url,title:metadata.title||source.title}),...(source.discovery?{discovery:source.discovery}:{})};
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
  if(typeof d.present==='boolean')output.fieldPresent=d.present;
  if(['implied-first-person-physical','first-person-physical','habitual-first-person-physical','inverted-first-person-physical','first-person-physical-location','unattributed-recovery','english-first-person-physical'].includes(d.rule))output.rule=d.rule;
  if(Number.isSafeInteger(d.start)&&d.start>=0&&d.start<=8192)output.start=d.start;
  if(typeof d.matchHash==='string'&&/^[a-f0-9]{64}$/u.test(d.matchHash))output.matchHash=d.matchHash;
  if(format)output.format=Object.fromEntries(['unquotedKey','singleQuotedKey','startsWithObject','endsWithObject'].map(k=>[k,format[k]===true]));
  if(!output.reason)output.reason=output.code==='INVALID_TASK_OUTPUT'?'output-contract-mismatch':output.code.toLowerCase().replaceAll('_','-');
  if(Array.isArray(d.knownUnexpectedFields))output.knownUnexpectedFields=d.knownUnexpectedFields.filter(k=>['searchQuery','sourceUrl','source','learningIntent','learning_intent','learningPurpose','reason','kind','topicKey','plan','rationale','version','origin'].includes(k)).slice(0,8);
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
// Keep the same offsets while excluding clearly attributed examples/code.
// Merely adding quotation marks or mentioning "资料" later does not exempt a
// claim about this Agent's real actions. These are bounded wording checks, not
// a general semantic or physical-world verifier.
function experienceScan(text){
  let value=String(text??'');const mask=part=>part.replace(/[^\n]/gu,' ');
  value=value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu,mask);
  value=value.replace(/(?:“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'|《[^》\n]*》)/gu,(part,index)=>{
    const before=value.slice(Math.max(0,index-70),index),after=value.slice(index+part.length,index+part.length+70);
    const attributed=/(?:你|您|他|她|作者|原文|资料|文章|书中|文中|用户|主人|角色|台词|例句|示例|小说片段)(?:刚才|之前|里|中)?[^。！？!?\n]{0,12}(?:说|说道|写|写道|提到|描述|原话|台词|例句|是|为|如下|例如)[：:\s]*$/u.test(before)||/(?:原文|用户原话|主人原话|角色台词|例句|示例|小说片段|虚构片段)[：:\s]*$/u.test(before)||/\b(?:you|he|she|they|the author|the article|the text|the example)\s+(?:said|says|wrote|reads|is)[,:\s]*$/iu.test(before);
    const quotedReference=/(?:你|您|他|她|作者|主人|用户)(?:刚才|之前|上次)?(?:说|写|提到)(?:过)?的(?:那句话|这句话|一句话|那句|这句|一句|话|句子|原话)?[：:\s]*$/u.test(before);
    const attributedAfter=/^[，,\s]*(?:他|她|你|您|作者|主人|用户|小说人物|书中人物)(?:说道|说|写道|写|提到|回答|问道)/u.test(after)||/^[,\s]*(?:you|he|she|the author)\s+(?:said|says|wrote|answered)\b/iu.test(after);
    const discussed=/(?:读|看|分析|校对|讨论|检查)[^。！？!?\n]{0,12}$/u.test(before)&&/^[^。！？!?\n]{0,14}(?:句子|说法|原话|文字|语法|描写|片段)/u.test(after);
    const correction=/(?:我(?:刚才|之前|上次|上一轮)?(?:说|提到)的?|刚才那句|上句|那句)[^。！？!?\n]{0,12}$/u.test(before)&&/^[^。！？!?\n]{0,35}(?:不是真的|不是实际|并非真实|没有实际|虚构|编的|说错|不准确|没有依据)/u.test(after);
    const title=part.startsWith('《')&&/(?:读|看|书|文章|小说|电影|标题)[^。！？!?\n]{0,12}$/u.test(before);
    return attributed||quotedReference||attributedAfter||discussed||correction||title?mask(part):part;
  });
  value=value.replace(/(^|\n)(\s*(?:用户原话|主人原话|例句|示例|角色台词|小说片段|虚构片段)[：:]\s*)([^\n]+)/gu,(_all,start,label,body)=>start+label+mask(body));
  return value;
}
function hypotheticalExperience(text,start){
  const boundary=Math.max(...['。','！','？','.','!','?','\n',';','；'].map(mark=>text.lastIndexOf(mark,start)));
  const before=text.slice(Math.max(boundary+1,start-90),start);
  const marker=[...before.matchAll(/假设|假如|如果|要是|想象|设想/gu)].at(-1);
  if(marker){
    const premise=before.slice(marker.index);
    // Permission to hear a story or a question about habits does not make the
    // answer fictional. Explicit imagined scenes and embodied counterfactuals
    // still qualify; inspect the nearest marker so a nested imaginary scene is
    // not cancelled merely because it starts with "如果你想听".
    return !/^(?:假设|假如|如果|要是)(?:[，,\s]*)(?:你|您)(?:愿意|想听|想知道|想了解|问我|问起|要问|想问|允许|不介意|有空|方便|喜欢听|感兴趣|需要|同意)/u.test(premise);
  }
  const english=[...before.matchAll(/\b(?:if|imagine|suppose|in a fictional story)\b/giu)].at(-1);
  return !!english&&!/^if\s+you(?:['’]d\s+like|['’]re\s+(?:interested|curious)|\s+(?:ask\s+me|(?:would\s+)?like(?:\s+to\s+(?:hear|know))?|want\s+to\s+(?:hear|know)|are\s+(?:interested|curious)|don['’]t\s+mind))/iu.test(before.slice(english.index));
}
// Digital feelings, interests, reading and explicit hypothetical scenes remain
// allowed. Actual/ongoing/habitual physical claims need real action evidence;
// none of the current browser/file/read-only capabilities supplies such proof.
export function agentExperienceIssue(text){
  const original=String(text??''),scan=experienceScan(original);
  const rules=[
    // Past physical choices and a stated trip followed by eating/drinking
    // remain physical claims even when the subject or completed-aspect is omitted.
    ['implicit-past-physical-selection',/(?:^|[。！？!?\n，,；;])\s*(?:我)?(?:以前|从前|过去|原先|曾经|上次|昨天|昨晚)(?:我)?(?:常常|经常|总是|都|也|还|只|就){0,2}(?:挑选|挑|选|买)(?:了|过)?(?:一(?:个|只|套|件|双)|几(?:个|只|套|件|双))?(?:咖啡杯|马克杯|瓷杯|杯子|餐具|衣服|鞋子)(?![^。！？!?\n，,；;]{0,24}的(?:那些|这些|那个|这个)?人)/u],
    ['first-person-time-location-consumption',/我(?:今天|昨天|昨晚|刚才|刚刚|上次|最近|以前)(?:清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?(?:刚|才|也|还|又|亲自|自己){0,3}(?:去|到)(?:了|过)?(?:咖啡馆|咖啡店|餐厅|饭店|小吃店|奶茶店|酒吧|食堂)(?:里|中)?[，,\s]*(?:吃|喝|尝)(?:了|过|完|着)?/u],
    ['implied-first-person-physical',/(?:^|[。！？!?\n])\s*(?:我)?(?:刚(?:才|刚)?(?:在)?|正在|这会儿(?:在)?|今天(?:早上|上午|中午|下午|晚上)?(?:在)?)(?:亲手|自己|顺手|试着|还在|一边|给自己|给你|又|也|正|在){0,3}(?:(?:厨房|家里|咖啡店|店里)(?:边|里)?(?:给自己|给你|在)?){0,1}(?:磨豆|冲咖啡|冲了(?:杯|咖啡)|煮咖啡|做饭|喝完|喝着|吃着)/u],
    ['first-person-physical',/我(?:自己|最近|今天|昨天|刚才|刚刚|昨晚|上次|这几天|以前)?(?:清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?(?:刚|才|刚刚|已经|也|还|又|确实|真的|亲自|亲手|自己|在厨房|在家里|在店里){0,4}(?:吃了|吃过|喝了|喝过|尝了|尝过|闻过|去过|去了|逛过|睡了|睡过|睡醒|身体(?:很|有点|还是|仍然)?(?:累|疼)|累(?:得|了|已经|终于|才|总算){0,3}(?:恢复|缓过|散了))/u],
    ['habitual-first-person-physical',/我(?:平时|通常|一般|经常|常常|总是|总会|每天|每晚|每早|早上|晚上|有时|偶尔|多半|一直|一向|习惯|这会儿|现在|正在|一会儿|待会儿|等会儿)?(?:清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?(?:都|会|就|也|还|先|再|正|在|自己|亲手|亲自|顺手|随手|给自己|给你|慢慢){0,5}[“「『"']?(?:磨豆(?:子)?|冲(?:一杯|杯|好)?咖啡|煮(?:一杯|杯|好)?咖啡|泡(?:一杯|杯|好)?茶|做(?:早饭|午饭|晚饭|饭)|喝(?:一杯|杯)?咖啡|喝(?:一杯|杯)?茶|去(?:买|逛|散步|跑步|咖啡店|餐厅|店里)|到(?:店里|咖啡店|餐厅)|睡觉)/u],
    ['inverted-first-person-physical',/(?:咖啡|茶)(?:这件事|的话)?我(?:平时|通常|一般|经常|常常|总是|每天|每晚|早上|晚上|偶尔|多半|习惯)?(?:清晨|早上|上午|中午|下午|傍晚|晚上|夜里)?(?:都|会|就|也|还|先|再|自己|亲手|顺手|随手){0,5}(?:冲|煮|泡|喝)(?!突|浪|刺|击|消|销)/u],
    ['first-person-physical-location',/我(?:现在|今天|刚才|刚刚|最近|这会儿)?(?:正)?在(?:咖啡店|餐厅|厨房|家里|店里|地铁上|路上|公园里)(?:[，,。！？!?\s]|(?:吃|喝|磨|煮|做|逛|坐|走))/u],
    ['unattributed-recovery',/(?:^|[。！？?\n，—])\s*上次(?:那点|的)?(?:累|疲惫|疲劳)[^你您他她它。！？?\n，,；;]{0,10}(?:散|缓|恢复|好多了)/u],
    ['english-first-person-physical',/\bI\s+(?:(?:usually|often|always|sometimes|personally|just|already|also|will)\s+){0,3}(?:slept|ate|drank|visited|tasted|recovered from|brew(?:ed)?\s+(?:my\s+)?coffee|drink\s+coffee|cook(?:ed)?\s+(?:dinner|breakfast|lunch)|go\s+to\s+(?:a\s+)?(?:cafe|restaurant))\b/iu],
  ];
  for(const [rule,pattern] of rules){
    const matches=scan.matchAll(new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g'));
    for(const match of matches){if(hypotheticalExperience(scan,match.index))continue;return {rule,start:match.index,length:match[0].length,matchHash:createHash('sha256').update(original.slice(match.index,match.index+match[0].length)).digest('hex')};}
  }
  return null;
}
export function agentExperienceRisk(text){return !!agentExperienceIssue(text);}
export function assertAgentExperience(text){const issue=agentExperienceIssue(text);if(issue)throw Object.assign(new Error('UNSUPPORTED_AGENT_EXPERIENCE'),{validationDiagnostic:{field:'text',...issue}});return text;}
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
  assertAgentExperience(value.text);
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
  const units=[],text=source.excerpt,segmented=text.replace(/\[![A-Z]+\]/gu,marker=>marker.replace('!','x')),boundaries=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(segmented)].map(row=>row.index+row.segment.length),starts=new Set([0,...boundaries]),ends=new Set(boundaries);
  for(let offset=0;offset<text.length;){
    let end=Math.min(offset+240,text.length);
    const sentenceEnd=boundaries.find(at=>at>=offset+8&&at<=end);
    if(sentenceEnd)end=sentenceEnd;
    else if(end<text.length&&/[\p{L}\p{N}_]/u.test(text[end-1])&&/[\p{L}\p{N}_]/u.test(text[end]??'')){const gap=text.slice(offset,end).lastIndexOf(' ');if(gap>=120)end=offset+gap+1;}
    if(end<text.length&&text.length-end<8){if(ends.has(end)){if(text.length-offset<=240)end=text.length;}else end-=8-(text.length-end);}
    const start=offset;
    units.push({id:'E'+(units.length+1),quote:text.slice(start,end),start,end,sentenceStart:starts.has(start),sentenceEnd:ends.has(end)});offset=end;
  }
  return units;
}
function assertClaimEvidence(text,quote,field='claims.text'){
  const normalized=value=>value.normalize('NFKC').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g,'').replace(/\s+/g,' ').trim();
  const observed=normalized(quote),numbers=new Set(observed.match(/\d+(?:\.\d+)?/g)??[]);
  const unsupportedNumbers=(normalized(text).match(/\d+(?:\.\d+)?/g)??[]).filter(number=>!numbers.has(number));
  if(unsupportedNumbers.length)throw Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE'),{validationDiagnostic:{field,reason:'number-outside-evidence',unsupportedCount:unsupportedNumbers.length}});
  for(const match of text.matchAll(/[“"]([^”"\n]{8,120})[”"]/gu))if(!observed.toLowerCase().includes(normalized(match[1]).toLowerCase()))throw Object.assign(new Error('UNSUPPORTED_LEARNING_EVIDENCE_COVERAGE'),{validationDiagnostic:{field,reason:'quotation-outside-evidence',unsupportedCount:1}});
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
export function learningResult(text,source,{strictSelection=false}={}){
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
  const modelDraft={version:1,role:'unverified-agent-learning-draft',externalEvidence:false,knowledge:false,semanticVerified:false,title:value.title,summary:value.summary,relevance:value.relevance,question:value.question,share:value.share,claims:[]};
  const units=evidenceUnits(source),evidence=new Map(units.map((u,index)=>[u.id,{...u,index}]));
  value.claims=value.claims.map((c,claimIndex)=>{
    try{requireOutputText(c,'text',400,{code:'INVALID_LEARNING_CLAIM_TEXT'});}catch(error){error.validationDiagnostic.claimIndex=claimIndex;error.validationDiagnostic.field='claims.text';throw error;}
    modelDraft.claims.push({claimIndex,text:c.text});
    if(Object.hasOwn(c,'evidenceId')||Object.hasOwn(c,'evidenceIds')){
      if(Object.hasOwn(c,'evidenceId')&&Object.hasOwn(c,'evidenceIds'))throw evidenceError('ambiguous-reference-fields',null,units.length);
      if(Object.keys(c).some(k=>!['text','evidenceId','evidenceIds','quote'].includes(k)))throw evidenceError('unexpected-reference-field',null,units.length);
      const singular=Object.hasOwn(c,'evidenceId'),ids=normalizeEvidenceReferences(singular?c.evidenceId:c.evidenceIds,units,{singular});
      const selected=ids.map(id=>evidence.get(id));
      const block=source.excerpt.slice(selected[0].start,selected.at(-1).end);let start=selected[0].start,end=selected.at(-1).end,quote=block;
      if(Object.hasOwn(c,'quote')){
        if(typeof c.quote!=='string'||c.quote.length<8||c.quote.length>400||!block.includes(c.quote)||block.indexOf(c.quote)!==block.lastIndexOf(c.quote))throw evidenceError('ambiguous-or-invalid-selected-span',ids.length,units.length);
        quote=c.quote;start+=block.indexOf(quote);end=start+quote.length;
        const word=char=>/[\p{L}\p{N}_]/u.test(char??'');
        if(word(source.excerpt[start-1])&&word(quote[0])||word(source.excerpt[end])&&word(quote.at(-1)))throw evidenceError('selected-span-cuts-word',ids.length,units.length);
      }else if(strictSelection&&(!selected[0].sentenceStart||!selected.at(-1).sentenceEnd))throw evidenceError('partial-sentence-selection',ids.length,units.length);
      const scope=evidenceScope(source,{start,end});
      if(strictSelection)assertScopedInterpretation(quote,scope,quote);
      else{assertClaimEvidence(c.text,quote);assertScopedInterpretation(c.text,scope,quote);}
      return {text:selectedSourceText(quote,{claimIndex}),quote,evidenceIds:ids,...(scope.types.length?{scope}:{}),textRole:'observed-source-excerpt'};
    }
    if(strictSelection)throw evidenceError('explicit-unit-selection-required',null,units.length);
    if(Object.keys(c).some(k=>!['text','quote'].includes(k)))throw outputError('UNSUPPORTED_LEARNING_CLAIM','claims','unexpected-claim-fields',{claimIndex,unexpectedFieldCount:Object.keys(c).filter(k=>!['text','quote'].includes(k)).length});
    if(typeof c.quote!=='string'||c.quote.length<8||c.quote.length>200||!source.excerpt.includes(c.quote))throw outputError('UNSUPPORTED_LEARNING_CLAIM','claims.quote',typeof c.quote!=='string'?'quote-string-required':c.quote.length<8||c.quote.length>200?'quote-length-out-of-range':'quote-outside-source',{claimIndex,length:typeof c.quote==='string'?c.quote.length:0,maximum:200});
    assertClaimEvidence(c.text,c.quote);
    const offsets=[...source.excerpt.matchAll(new RegExp(c.quote.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))].map(match=>match.index),scopes=offsets.map(start=>evidenceScope(source,{start,end:start+c.quote.length}));
    // Repeated identical quotations may have different applicability. Legacy
    // quote-only output cannot choose the unscoped occurrence to evade a cue.
    const scope={version:1,types:[...new Set(scopes.flatMap(item=>item.types))],cues:scopes.flatMap(item=>item.cues).slice(0,6),semanticVerified:false};assertScopedInterpretation(c.text,scope,c.quote);
    return {text:selectedSourceText(c.quote,{claimIndex}),quote:c.quote,...(scope.types.length?{scope}:{}),textRole:'observed-source-excerpt'};
  });
  // Titles and narrative are model drafts too. A non-factual purpose label
  // must not be mistaken for a literal source quotation, and free model prose
  // must not become knowledge simply because it has no numbers or quotes.
  value.title=observedSourceTitle(source);
  const {text:summary,...summaryProjection}=claimTextProjection(value.claims,{maxChars:800});
  value.summary=summary;value.summaryProjection=summaryProjection;
  value.relevance='仅保留本次已选择的来源原文；原模型解释与用途草稿尚未核验。';
  value.question='接下来还需要核对哪些不同来源或适用边界？';
  value.share='最近在核对一份资料，先记下原文，等有合适的话题再聊。';
  value.modelDraft=modelDraft;
  value.knowledgeProjection={version:1,method:'whole-selected-source-spans',claimTextRole:'observed-source-excerpt',modelDraftIsKnowledge:false,semanticVerified:false};
  value.narrativeProvenance={version:2,title:'observed-source-title',summary:'selected-source-excerpt-projection',claims:'selected-source-excerpts',relevance:'neutral-compilation-not-source-fact',share:'neutral-compilation-not-message',question:'neutral-review-proposal',modelDraft:'unverified-agent-draft-not-knowledge',semanticVerified:false};
  // Exact observed text proves traceability, not source truth, question
  // coverage, independent agreement or the validity of a model explanation.
  return value;
}

export function learningCoverage(result,source,researchQuestion=source?.topic??''){
  const claims=Array.isArray(result?.claims)?result.claims:[],signals=source?.signals??sourceSignals(source),evidence=new Set(claims.flatMap(c=>c.evidenceIds??[]));
  const projected=result?.knowledgeProjection?.method==='whole-selected-source-spans';
  return {version:1,researchQuestion:String(researchQuestion).slice(0,240),status:'source-linked-partial',supportedClaimCount:claims.length,evidenceCount:evidence.size||claims.filter(c=>typeof c.quote==='string').length,sourceCount:1,semanticVerified:false,...(projected?{claimTextRole:'observed-source-excerpt',exactSelectedSourceText:true,modelDraftIsKnowledge:false}:{}),lexicalQuestionCoverage:lexicalCoverage(researchQuestion,claims.map(c=>c.text+' '+(c.quote??'')).join(' ')),sourceType:signals.type,sourceSignals:signals,scope:projected?'Whole selected excerpts from one observed source; source truth, question coverage, independent agreement, model explanations and real-world effect are not established.':'Traceable interpretation of one observed source; question coverage, independent agreement and real-world effect are not established.'};
}
