import {createHash} from 'node:crypto';
const fail=code=>{throw new Error(code);};
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/i.test(value);
const norm=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const integer=(value,max)=>Number.isSafeInteger(value)&&value>=0&&value<=max?value:fail('INVALID_GOAL_ACCEPTANCE');
const terms=(value,max,length)=>{if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!v.trim()||v.trim().length>length||secret(v)||!norm(v)))fail('INVALID_GOAL_ACCEPTANCE');return [...new Set(value.map(v=>v.trim()))];};

export function goalAcceptance(value={},legacy=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['minNotes','minIndependentSources','requiredTerms','requiredQuestions','ownerReview'].includes(k)))fail('INVALID_GOAL_ACCEPTANCE');
  if(value.ownerReview!==undefined&&typeof value.ownerReview!=='boolean')fail('INVALID_GOAL_ACCEPTANCE');
  return {minNotes:integer(value.minNotes??(legacy?0:1),16),minIndependentSources:integer(value.minIndependentSources??(legacy?0:1),16),requiredTerms:terms(value.requiredTerms??[],12,80),requiredQuestions:terms(value.requiredQuestions??[],8,240),ownerReview:value.ownerReview??false};
}
export function goalSupport(value={},legacy=false){
  const priority=value.priority??3,expectedValue=value.expectedValue??'';
  if(!Number.isSafeInteger(priority)||priority<1||priority>5||typeof expectedValue!=='string'||expectedValue.trim().length>500||secret(expectedValue))fail('INVALID_GOAL_VALUE');
  return {version:legacy?1:2,priority,expectedValue:expectedValue.trim(),acceptance:goalAcceptance(value.acceptance??{},legacy),revisionCount:value.revisionCount??0,revisions:value.revisions??[],review:value.review??null,origin:value.origin??'owner-plan',schedule:value.schedule??{virtualRuntime:0,lastTurn:0,lastSelectedAt:null}};
}

// These checks establish bounded evidence coverage, not semantic truth or a
// real-world outcome. Different hosts and different content hashes are a
// conservative source-count heuristic; ownership independence is unverified.
export function evaluateGoal(row,notes,now){
  const support=row.support,acceptance=support.acceptance,unique=new Map(notes.map(note=>[note.id,note])),records=[...unique.values()];
  const byHost=new Map(),sources=[];
  for(const note of records){const source=note.data.source,host=new URL(source.url).hostname.toLowerCase().replace(/^www\./u,'');if(!byHost.has(host))byHost.set(host,new Set());byHost.get(host).add(source.digest);sources.push({noteId:note.id,url:source.url,host,digest:source.digest});}
  const matched=new Map();
  function match(host,seen){for(const digest of byHost.get(host)){if(seen.has(digest))continue;seen.add(digest);if(!matched.has(digest)||match(matched.get(digest),seen)){matched.set(digest,host);return true;}}return false;}
  for(const host of byHost.keys())match(host,new Set());
  const independentSourceCount=matched.size,text=records.flatMap(n=>[n.data.title,n.data.summary,...n.data.claims.map(c=>c.text)]).map(norm);
  const questions=records.map(n=>norm(n.data.researchQuestion??n.data.title));
  const checks=[{code:'minimum-notes',label:'有效来源笔记',expected:acceptance.minNotes,actual:records.length,met:records.length>=acceptance.minNotes},{code:'independent-sources',label:'不同站点且内容不重复的来源',expected:acceptance.minIndependentSources,actual:independentSourceCount,met:independentSourceCount>=acceptance.minIndependentSources},...acceptance.requiredTerms.map(term=>({code:'required-term',label:'必要词项：'+term,expected:term,met:text.some(value=>value.includes(norm(term)))})),...acceptance.requiredQuestions.map(question=>({code:'required-question',label:'必要研究问题：'+question,expected:question,met:questions.some(q=>q.includes(norm(question)))}))];
  const basis=createHash('sha256').update(JSON.stringify({acceptance,notes:records.map(n=>[n.id,n.data.source.digest,n.data.researchQuestion,n.data.title,n.data.summary,n.data.claims]).sort((a,b)=>a[0].localeCompare(b[0])),steps:row.steps.map(s=>[s.id,s.status,s.receipt??null])})).digest('hex');
  const executionComplete=row.steps.every(s=>s.status==='completed'),evidenceSatisfied=checks.every(c=>c.met),ownerAccepted=support.review?.accepted===true&&support.review.basis===basis,unmet=checks.filter(c=>!c.met);
  if(acceptance.ownerReview&&!ownerAccepted)unmet.push({code:'owner-review',label:'等待主人确认验收',expected:true,actual:false,met:false});
  const achieved=executionComplete&&evidenceSatisfied&&(!acceptance.ownerReview||ownerAccepted),reports=row.steps.filter(s=>s.kind==='write-report'&&s.status==='completed');
  return {version:2,kind:'bounded-evidence-acceptance',basis,at:now,completedSteps:row.steps.filter(s=>s.status==='completed').length,totalSteps:row.steps.length,executionComplete,evidenceSatisfied,ownerAccepted,achieved,noteIds:[...unique.keys()],noteCount:records.length,independentSourceCount,sources,checks,unmet,acceptance,review:support.review,...(reports.length?{actions:reports.map(s=>({actionId:s.actionId,...s.receipt}))}:{}),method:'normalized-phrase-coverage-and-distinct-host-content',scope:achieved?'配置的步骤和验收条件已满足；词项与问题仅做规则覆盖检查，不代表现实效果已经验证。':executionComplete?'执行步骤已经完成；仍需满足列出的证据或主人验收条件，目标尚未达成。':'正在执行有限步骤；完成后仍需检查配置的验收条件。'};
}
