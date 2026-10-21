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
  const text=String(query??'').normalize('NFKC'),terms=retrievalTerms(text,{expand:false,limit:40});
  const identifiers=[...new Set((text.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)??[]).filter(word=>/[a-z][A-Z]|[A-Za-z]\d|^[A-Z]{2,8}$/u.test(word)).map(normalized))].slice(0,8);
  return {terms,identifiers};
}

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
  const profile=questionSignals(query),terms=profile.terms,title=normalized(row.title),snippet=normalized(row.snippet),url=normalized(row.url);
  const identifiers=[...new Set([...profile.identifiers,...questionSignals(question).identifiers])].slice(0,8);
  const hits=terms.filter(term=>title.includes(term)||snippet.includes(term)||url.includes(term));
  const identifierHits=identifiers.filter(term=>title.includes(term)||snippet.includes(term)||url.includes(term));
  const extra=retrievalTerms(question,{expand:false,limit:24}).filter(term=>!terms.includes(term)),questionHits=extra.filter(term=>title.includes(term)||snippet.includes(term));
  const signals=sourceSignals(row),specific=identifiers.length>0;
  const score=hits.reduce((sum,term)=>sum+(title.includes(term)?3:0)+(snippet.includes(term)?1:0)+(url.includes(term)?1:0),0)+identifierHits.length*5+Math.min(3,questionHits.length)+(signals.primaryCandidate?2:0);
  return {...row,sourceSignals:signals,relevance:{version:1,score,matchedCount:hits.length,termCount:terms.length,identifierHits:identifierHits.length,identifierCount:identifiers.length,questionMatchedCount:questionHits.length,lexicalOnly:true,specificQuestion:specific},_relevant:!terms.length||hits.length>0};
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
  return typeof text==='string'&&(/【[^】]*(?:测试|短测|验收|开发)[^】]*】|\[(?:dev[ -]?test|test[ -]?fixture|acceptance[ -]?test)\]/iu.test(text)||/(?:这(?:条|只是|仅)|仅(?:供|用于)|本(?:条|轮)).{0,16}(?:开发测试|开发短测|测试输入|功能测试|验收测试|测试消息)|不(?:代表|作为|是).{0,12}(?:真实经历|个人偏好|真实偏好|真实需求)|仅用于测试|开发测试[：:]|^(?:恢复闲聊测试|暂停恢复测试|手机入站短测|通道刷新补测)/u.test(text));
}
