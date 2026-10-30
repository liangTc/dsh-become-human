// Deterministic retrieval hints, not semantic inference or evidence of a fact.
// Synonyms only widen a lookup; the stored wording and its source never change.
const aliases=[
  ['人工智能','ai','artificial intelligence'],['智能体','agent','agents'],
  ['记忆','memory','memories'],['上下文','context'],['检索','搜索','search','retrieval'],
  ['咖啡','coffee','cafe','café'],['茶','tea'],['模型','model','models'],
  ['学习','learning','learn','study'],['提醒','reminder','reminders'],
  ['工具','tool','tools'],['只读','read-only','readonly','readonlyhint'],
  ['规范','specification','specifications','spec'],['权限','permission','permissions','authorization'],
  ['睡眠','睡觉','sleep'],['工作','work'],['生活','life'],['天气','weather'],
];
const ignored=new Set(['the','and','for','with','from','what','how','are','is','to','of','in','on','an','a','or','as','be','it','this','that','can','would','could','please','关于','什么','如何','哪些','一个','最新','研究','资料','问题','了解','根据','通过','可以','是否','需要','学习','进行','已有']);
const normalized=value=>String(value??'').normalize('NFKC').toLowerCase();
const contains=(text,term)=>/[\u4e00-\u9fff]/u.test(term)?text.includes(term):new RegExp('(?:^|[^a-z0-9_])'+term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9_])','u').test(text);

export function retrievalTerms(value,{expand=true,limit=40}={}){
  const text=normalized(value),words=text.match(/[a-z0-9][a-z0-9_.+#-]{1,}|[\u4e00-\u9fff]{2,}/gu)??[];
  const terms=[];
  for(const word of words){
    if(!ignored.has(word)&&!/^\d+$/u.test(word))terms.push(word);
    if(/^[\u4e00-\u9fff]{3,}$/u.test(word))for(let i=0;i<word.length-1;i++){const term=word.slice(i,i+2);if(!ignored.has(term))terms.push(term);}
  }
  const original=[...new Set(terms)].slice(0,limit),expanded=[];
  if(expand)for(const group of aliases)if(group.some(term=>contains(text,term)))expanded.push(...group.filter(term=>!original.includes(term)));
  // Keep room for both the original question and translated topic terms.
  return [...new Set([...original.slice(0,Math.max(8,limit-expanded.length)),...expanded,...original])].slice(0,limit);
}

export function questionSignals(query){
  const text=String(query??'').normalize('NFKC'),codes=[];
  // Numeric values are normally omitted from lexical retrieval. Preserve only
  // explicitly named HTTP response codes; years, prices and other bare values
  // must not become an exact-identifier requirement for an unrelated lookup.
  if(/\bhttps?(?:\/\d(?:\.\d)?)?\b/iu.test(text)){
    let previous=null;
    const currency=/^\s*(?:万元|千元|元|块|美元|人民币|日元|欧元|英镑|港元|港币|澳元|加元|usd\b|cny\b|rmb\b|dollars?\b|euros?\b|eur\b|gbp\b|円|yen\b|%)/iu;
    for(const match of text.matchAll(/\b[1-5]\d{2}\b/gu)){
      const code=match[0],at=match.index,before=text.slice(Math.max(0,at-100),at),after=text.slice(at+code.length);
      const commaCodes=/^,\s*[1-5]\d{2}(?![\dA-Za-z]|\.\d)/u.test(after),grouped=/^(?:,\d{3})+/u.exec(after)?.[0];
      const money=/(?:[$￥¥€£]\s*|(?:价格|费用|预算|金额|cost|price|budget)\s*[:：]?\s*)$/iu.test(before)||/^\.\d/u.test(after)||/^,\d/u.test(after)&&(!commaCodes||!!grouped&&currency.test(after.slice(grouped.length)))||currency.test(after);
      const direct=/\bhttp(?:\/\d(?:\.\d)?)?(?:\s+(?:(?:response\s+)?status(?:\s+codes?)?|responses?(?:\s+codes?)?))?\s*[:：-]?\s*$/iu.test(before);
      const named=/(?:状态码|响应状态(?:码)?|响应码|status(?:\s+codes?)?)\s*[:：-]?\s*$/iu.test(before)||/^\s*(?:状态码|响应状态|响应码|status(?:\s+code)?\b|No\s+Content\b|Not\s+Modified\b)/iu.test(after);
      const listed=previous&&/^\s*(?:responses?\s+)?(?:[/,，、和与或-]|以及|and|or|with|versus|vs\.?)?\s*$/iu.test(text.slice(previous.end,at));
      if(!money&&(direct||named||listed)){codes.push(code);previous={end:at+code.length};}
    }
  }
  const httpStatusCodes=[...new Set(codes)].slice(0,8),terms=[...new Set([...httpStatusCodes,...retrievalTerms(text,{expand:false,limit:40})])].slice(0,40);
  const identifiers=[...new Set([...httpStatusCodes,...(text.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)??[]).filter(word=>/[a-z][A-Z]|[A-Za-z]\d|^[A-Z]{2,8}$/u.test(word)).map(normalized)])].slice(0,8);
  return {terms,identifiers,httpStatusCodes};
}

const signalMatch=(value,term)=>contains(value,term);

export function sourceSignals(row={}){
  let u;try{u=new URL(row.url);}catch{return {type:'unknown',primaryCandidate:false,authorityVerified:false};}
  const host=u.hostname.toLowerCase(),text=normalized(u.pathname+' '+(row.title??''));
  const specification=/\b(?:specification|specifications|rfc)\b|\/spec(?:\/|$)|规范|标准/u.test(text);
  const paper=/arxiv\.org$|doi\.org$|pubmed\.ncbi\.nlm\.nih\.gov$/u.test(host)||/\/papers?\/|\bpaper\b|论文/u.test(text);
  const documentation=specification||/^docs\.|\/docs?\/|\/reference\/|\/documentation\/|开发文档|官方文档/u.test(host+u.pathname+' '+(row.title??''));
  const repository=host==='github.com'||host==='gitlab.com';
  const community=/blog\.|csdn\.net$|zhihu\.com$|reddit\.com$|medium\.com$/u.test(host);
  return {type:specification?'specification-candidate':paper?'paper-candidate':documentation?'documentation-candidate':repository?'repository':community?'community':'general',primaryCandidate:specification||paper||documentation||repository,authorityVerified:false};
}

export function scoreResearchResult(query,row,{question=''}={}){
  const profile=questionSignals(query),questionProfile=questionSignals(question),terms=profile.terms,title=normalized(row.title),snippet=normalized(row.snippet),url=normalized(row.url);
  const identifiers=[...new Set([...profile.identifiers,...questionProfile.identifiers])].slice(0,8);
  const hits=terms.filter(term=>signalMatch(title,term)||signalMatch(snippet,term)||signalMatch(url,term));
  const identifierHits=identifiers.filter(term=>signalMatch(title,term)||signalMatch(snippet,term)||signalMatch(url,term));
  const extra=retrievalTerms(question,{expand:false,limit:24}).filter(term=>!terms.includes(term)),questionHits=extra.filter(term=>title.includes(term)||snippet.includes(term));
  const signals=sourceSignals(row),specific=identifiers.length>0;
  // A generic HTTP/MDN overview cannot satisfy an explicitly requested status
  // merely by matching the protocol or publisher. A comparison may retain
  // separate pages for its individual codes; discovery is still not evidence.
  const codes=[...new Set([...profile.httpStatusCodes,...questionProfile.httpStatusCodes])];
  // A publisher/acronym alone (for example a generic agency home page) is
  // insufficient for a multi-word question. Precise API identifiers and HTTP
  // codes may stand alone; they are still retrieval hints, not evidence.
  const precise=[...(query+' '+question).matchAll(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)].map(m=>m[0]).filter(w=>/[a-z][A-Z]|[A-Za-z]\d/u.test(w)).map(normalized);
  const numericProtocolContext=!codes.length&&/\bhttp\b/iu.test(query)&&/\d/u.test(query)&&hits.includes('http');
  const topicTerms=terms.filter(term=>!identifiers.includes(term)),contentTopicHits=topicTerms.filter(term=>signalMatch(title,term)||signalMatch(snippet,term));
  // Generic URL routes are not topic evidence. Require words in the visible
  // title/snippet beyond a publisher acronym. Latin keyword coverage also
  // prevents an entity overview from satisfying a longer mechanism question;
  // Chinese bigrams are not independent words and do not use that ratio.
  const latinKeywords=topicTerms.length>=4&&topicTerms.every(term=>/^[a-z0-9_.+#-]+$/u.test(term));
  const topicalContent=topicTerms.length?contentTopicHits.length>=Math.min(2,topicTerms.length)&&(!latinKeywords||contentTopicHits.length/topicTerms.length>=.4):identifierHits.length>0;
  const literalElement=topicTerms.some(term=>/^[a-z][a-z0-9:-]+$/u.test(term)&&(title.includes('<'+term+'>')||snippet.includes('<'+term+'>')));
  const genericContext=new Set(['api','http','https','docs','documentation','reference','specification','specifications','official','primary','source','guide']);
  const qualifiers=[...new Set([...terms,...questionProfile.terms])].filter(term=>!identifiers.includes(term)&&/^[a-z][a-z0-9_.+#-]*$/u.test(term)&&!genericContext.has(term));
  const qualifierHits=qualifiers.filter(term=>signalMatch(title,term)||signalMatch(snippet,term));
  // A CamelCase token may be a product or publisher, not an API. When the
  // question also names another concrete topic, require visible context for
  // that topic. A bare exact API lookup can still match its actual URL path.
  const preciseMatch=precise.some(term=>signalMatch(title,term)||signalMatch(snippet,term)||signalMatch(url,term))&&(!qualifiers.length||qualifierHits.length>0);
  const topicMatch=numericProtocolContext||literalElement||(precise.length?preciseMatch:topicalContent);
  const statusMatch=!codes.length||codes.some(code=>signalMatch(title,code)||signalMatch(snippet,code)||signalMatch(url,code));
  const score=hits.reduce((sum,term)=>sum+(signalMatch(title,term)?3:0)+(signalMatch(snippet,term)?1:0)+(signalMatch(url,term)?1:0),0)+identifierHits.length*5+Math.min(3,questionHits.length)+(signals.primaryCandidate?2:0);
  return {...row,sourceSignals:signals,relevance:{version:4,score,matchedCount:hits.length,termCount:terms.length,identifierHits:identifierHits.length,identifierCount:identifiers.length,questionMatchedCount:questionHits.length,topicMatchedCount:contentTopicHits.length,topicTermCount:topicTerms.length,qualifierCount:qualifiers.length,qualifierHits:qualifierHits.length,lexicalOnly:true,specificQuestion:specific},_relevant:statusMatch&&(!terms.length||(codes.length?hits.length>0:topicMatch))};
}

export function lexicalCoverage(question,text){
  const terms=retrievalTerms(question,{expand:false,limit:40}),observed=normalized(text),matched=terms.filter(term=>observed.includes(term));
  return {matchedCount:matched.length,totalTerms:terms.length,ratio:terms.length?matched.length/terms.length:0,semanticVerified:false};
}

export function topicKeys(text){
  const value=normalized(text);return aliases.filter(group=>group.some(term=>contains(value,term))).map(group=>group[0]).slice(0,6);
}

export function developmentInput(text){
  // Exclude explicit development fixtures without treating ordinary mentions
  // of a software test as proof that the owner's whole message is fictional.
  if(typeof text!=='string')return false;
  // Historical harness messages predate the bracketed marker. Recognize the
  // explicit fixture label/disclaimer, never a bare mention of software tests.
  return /【[^】]*(?:测试|短测|验收|开发)[^】]*】|\[(?:dev[ -]?test|test[ -]?fixture|acceptance[ -]?test)\]/iu.test(text)
    ||/(?:这(?:是一条|是一次|是一段|条|只是|仅)|仅(?:供|用于)|本(?:条|轮)).{0,16}(?:开发测试|开发短测|测试输入|功能测试|验收测试|测试消息)|不(?:代表|作为|是).{0,12}(?:真实经历|个人偏好|真实偏好|真实需求)|测试(?:文字|内容|材料).{0,8}(?:不构成|不代表|不作为).{0,20}(?:喜好|偏好|经历|事实)|仅用于测试|开发测试[：:]|^(?:恢复闲聊测试|暂停恢复测试|手机入站短测|通道刷新补测)/u.test(text)
    ||/^\s*(?:QWEN_SHORT_[A-Z0-9]+|(?:WEB_(?:FORMAL|RECOVERY)|HOST_IDEMPOTENCY)_\d{8}(?:_[A-Z])?|P0_FINAL_REAL_[A-Z]|新版(?:角色|普通消息抢占|开放学习抢占|执行阶段抢占|继续|部署|前台优先|出站)(?:测试|短测))[：:]/iu.test(text);
}
