import {fetchPublicDocument,researchUrl,sourceText} from './learning.mjs';
import {questionSignals,scoreResearchResult} from './knowledge-signals.mjs';

// Discovery discovers URLs, not evidence. Only a separately fetched document can
// become a learning note. Neither adapter can alter the Human or tool policies.
export function searchQuery(value){
  if(typeof value!=='string'||!value.trim()||value.length>240||/[\u0000-\u001f]/u.test(value)||/(?:sk-[\w-]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b)/i.test(value))throw new Error('INVALID_PUBLIC_SEARCH_QUERY');
  return value.trim();
}
const plain=value=>typeof value==='string'?sourceText(value,'text/html'):'';
export function relevantSearchResults(query,rows,{question=''}={}){
  // Rank exact identifiers, question words and candidate source types. These
  // are discovery signals only; neither ranking nor a publisher label is proof.
  return rows.map((row,index)=>({...scoreResearchResult(query,row,{question}),_index:index})).filter(row=>row._relevant).sort((a,b)=>b.relevance.identifierHits-a.relevance.identifierHits||b.relevance.score-a.relevance.score||a._index-b._index).map(({_index,_relevant,...row})=>row);
}
function normalized(rows){
  const seen=new Set(),results=[];
  for(const row of rows){try{const url=researchUrl(row.url);if(seen.has(url))continue;seen.add(url);results.push({url,title:(plain(row.title)||new URL(url).hostname).slice(0,100),snippet:plain(row.snippet).slice(0,360),publishedAt:typeof row.publishedAt==='string'?row.publishedAt.slice(0,100):null});}catch{continue;}if(results.length===20)break;}
  return results;
}
export function duckDuckGoResults(body){
  if(/anomaly\.js|anomaly-modal|challenge-form|bots use DuckDuckGo/i.test(body))throw new Error('SEARCH_CHALLENGE_REQUIRED');
  const rows=[];
  for(const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const attrs=Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),m[3]]));
    if(!/(?:^|\s)result__a(?:\s|$)/.test(attrs.class??''))continue;
    try{const link=new URL(attrs.href.replace(/&amp;/g,'&'),'https://html.duckduckgo.com/'),url=link.hostname.endsWith('duckduckgo.com')&&link.searchParams.has('uddg')?link.searchParams.get('uddg'):link.href;rows.push({url,title:match[2]});}catch{continue;}
  }
  return normalized(rows);
}
export function bingResults(body){
  if(/id=["']b_captcha|class=["'][^"']*captcha|verify you are human/i.test(body))throw new Error('SEARCH_CHALLENGE_REQUIRED');
  const rows=[];
  for(const item of body.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)){
    const heading=/<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(item[1]),anchor=heading&&/<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading[1]);
    if(!anchor)continue;
    const href=/\bhref\s*=\s*(["'])(.*?)\1/is.exec(anchor[1]);if(!href)continue;
    try{let link=new URL(plain(href[2]));
      if((link.hostname==='www.bing.com'||link.hostname==='cn.bing.com')&&link.pathname==='/ck/a'){
        const encoded=link.searchParams.get('u');if(!encoded?.startsWith('a1'))continue;
        link=new URL(Buffer.from(encoded.slice(2),'base64url').toString('utf8'));
      }
      const snippet=/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(item[1])?.[1]??'';
      rows.push({url:link.href,title:anchor[2],snippet});
    }catch{continue;}
  }
  if(!rows.length&&!/\bb_results\b|no results|没有找到/i.test(body))throw new Error('INVALID_SEARCH_RESPONSE');
  return normalized(rows);
}
export function searxngResults(body){
  let data;try{data=JSON.parse(body);}catch{throw new Error('INVALID_SEARCH_RESPONSE');}
  if(!Array.isArray(data.results))throw new Error('INVALID_SEARCH_RESPONSE');
  return normalized(data.results.slice(0,40).filter(r=>r&&typeof r==='object').map(r=>({url:r.url,title:r.title,snippet:r.content,publishedAt:r.publishedDate})));
}
async function searchOnce(query,settings,signal){
  query=searchQuery(query);let url;
  if(settings.searchProvider==='searxng'){
    const endpoint=new URL(researchUrl(settings.searchEndpoint));
    endpoint.searchParams.set('q',query);endpoint.searchParams.set('format','json');
    url=endpoint.href;
  }else if(settings.searchProvider==='duckduckgo'){
    const endpoint=new URL('https://html.duckduckgo.com/html/');endpoint.searchParams.set('q',query);url=endpoint.href;
  }else if(settings.searchProvider==='bing'){
    const endpoint=new URL('https://www.bing.com/search');endpoint.searchParams.set('q',query);url=endpoint.href;
  }else throw new Error('SEARCH_PROVIDER_NOT_CONFIGURED');
  const response=await fetchPublicDocument(url,signal);
  // An HTML login/challenge response is never treated as a JSON search result.
  const parsed=settings.searchProvider==='searxng'?searxngResults(response.body):settings.searchProvider==='bing'?bingResults(response.body):duckDuckGoResults(response.body);
  return {query,provider:settings.searchProvider,searchedAt:response.fetchedAt,searchUrl:response.url,parsed};
}
export function researchQueryPlan(query){
  const original=searchQuery(query),profile=questionSignals(original),words=original.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)??[];
  const specific=words.filter(word=>profile.identifiers.includes(word.toLowerCase()));
  let refined,reason;
  const precise=specific.find(word=>/[a-z][A-Z]|[A-Za-z]\d/u.test(word));
  if(profile.httpStatusCodes.length){
    const codes=profile.httpStatusCodes.map(code=>'"'+code+'"'),context=words.filter(word=>!/^https?$/iu.test(word)).slice(0,4);
    refined=['HTTP',...codes,...context,'specification'].join(' ');reason='http-status-primary-source';
    if(refined.length>240)refined=['HTTP',...codes,'specification'].join(' ');
  }else if(precise){
    refined=[...specific.filter(word=>word!==precise).slice(0,3),'"'+precise+'"','specification'].join(' ');reason='identifier-primary-source';
  }else if(specific.length){refined=original+' primary source';reason='topic-primary-source';
  }else if(/[\u4e00-\u9fff]/u.test(original)&&words.length){refined=words.slice(0,5).join(' ');reason='compact-public-keywords';}
  else{refined=original+(/[\u4e00-\u9fff]/u.test(original)?' 原始资料':' primary source');reason='primary-source-keywords';}
  const plan=[{query:original,reason:'original-query'}];
  if(refined&&refined!==original&&refined.length<=240)plan.push({query:searchQuery(refined),reason});
  return plan.slice(0,2);
}
export function adequateResearchResults(ranked){
  const first=ranked?.[0];
  return !!first&&(first.relevance.identifierCount?first.relevance.identifierHits===first.relevance.identifierCount:first.relevance.matchedCount/Math.max(1,first.relevance.termCount)>=.3&&ranked.length>=2);
}
export async function searchPublicWeb(query,settings,signal,{question=''}={}){
  const originalQuery=searchQuery(query),plan=researchQueryPlan(originalQuery),trace=[],candidates=new Map();let metadata,discarded=0;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
  for(const [index,step] of plan.entries()){
    deadline.throwIfAborted();let found;
    try{found=await searchOnce(step.query,settings,deadline);}catch(error){
      const code=/^[A-Z_]{3,64}$/u.test(error.message)?error.message:'SEARCH_UNAVAILABLE';trace.push({step:index+1,query:step.query,reason:step.reason,state:'failed',code});
      // Do not hammer a challenged, rate-limited or broken provider. The trace
      // survives the error so a failed first step is observable as well.
      throw Object.assign(error,{searchTrace:trace});
    }
    const ranked=relevantSearchResults(originalQuery,found.parsed,{question});discarded+=found.parsed.length-ranked.length;
    trace.push({step:index+1,query:step.query,reason:step.reason,state:ranked.length?'results':'no-relevant-results',code:ranked.length?null:found.parsed.length?'SEARCH_RESULTS_OFF_TOPIC':'SEARCH_NO_RESULTS',parsedCount:found.parsed.length,relevantCount:ranked.length,searchedAt:found.searchedAt});
    const {parsed,...current}=found;metadata=current;
    for(const row of ranked){const candidate={...row,searchContext:{query:step.query,provider:found.provider,searchedAt:found.searchedAt,step:index+1}};const prior=candidates.get(row.url);if(!prior||candidate.relevance.score>prior.relevance.score)candidates.set(row.url,candidate);}
    if(adequateResearchResults(ranked))break;
  }
  const results=[...candidates.values()].sort((a,b)=>b.relevance.identifierHits-a.relevance.identifierHits||b.relevance.score-a.relevance.score).slice(0,6);
  if(!results.length)throw Object.assign(new Error(trace.some(s=>s.parsedCount)?'SEARCH_RESULTS_OFF_TOPIC':'SEARCH_NO_RESULTS'),{searchTrace:trace});
  return {...metadata,query:originalQuery,...(trace.length>1?{originalQuery,refinement:plan[1].reason}:{}),queryPlanVersion:1,maxQueries:2,querySteps:trace,discardedOffTopic:discarded,results};
}
