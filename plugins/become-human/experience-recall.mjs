// Retrieval only: lexical and structural matches expose candidates to the
// model. They do not decide what to do or prove a strategy is useful.
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase();
const terms=value=>{
  const tokens=normalize(value).match(/[a-z0-9][a-z0-9_.+-]+|[\p{Script=Han}]{2,}/gu)??[],out=new Set();
  for(const word of tokens){out.add(word);if(/^[\p{Script=Han}]+$/u.test(word))for(let i=0;i<word.length-1;i++)out.add(word.slice(i,i+2));}
  return out;
};
export function experienceFocus(task,data={}){
  const options=task?.checkpoint?.opportunities??[],c=task?.checkpoint??{};
  return {query:[c.plan?.question,c.candidate?.question,...options.map(o=>o.question),...(data.input??[]).map(m=>m.content?.filter(c=>c.type==='text').map(c=>c.text).join(''))].filter(Boolean).join(' '),behaviorIds:[...new Set([c.behaviorId,...options.map(o=>o.behaviorId)].filter(Boolean))],roots:[...new Set([c.goal?.id,...options.map(o=>o.goal?.id)].filter(Boolean).map(id=>'goal:'+id))]};
}
export function recallExperience(store,agent,{query='',behaviorIds=[],roots=[],limit=8,strategyLimit=3}={}){
  if(typeof query!=='string'||!Array.isArray(behaviorIds)||!Array.isArray(roots)||!Number.isSafeInteger(limit)||limit<1||limit>64||!Number.isSafeInteger(strategyLimit)||strategyLimit<0||strategyLimit>16)throw Error('INVALID_EXPERIENCE_QUERY');
  const requested=terms(query),behaviors=new Set(behaviorIds),wantedRoots=new Set(roots),focused=!!(requested.size||behaviors.size||wantedRoots.size);
  const lexical=value=>{const found=terms(value);let hits=0;for(const term of requested)if(found.has(term))hits++;return hits/Math.sqrt(Math.max(1,found.size));};
  const rank=row=>{const r=row.data.receipt;return 20*(wantedRoots.has(row.data.root)?1:0)+5*(behaviors.has(r.behaviorId)?1:0)+lexical([r.question,r.expected,r.behaviorResult?.summary,r.reason].filter(Boolean).join(' '));};
  const compare=(a,b)=>b.score-a.score||b.row.created-a.row.created||a.row.id.localeCompare(b.row.id);
  const keep=(rows,row,score,max)=>{if(!max)return;rows.push({row,score});rows.sort(compare);if(rows.length>max)rows.pop();};
  const experiences=[],strategies=[],recent=[],cache=new Map();let scanned=0,validCount=0;
  // Scan metadata in a cursor; do not silently discard older records behind a
  // fixed newest-256 window. Retain only a bounded set of best candidates.
  for(const raw of store.db.prepare('SELECT * FROM human_experience WHERE agent=? ORDER BY created DESC,id DESC').iterate(agent)){
    scanned++;const row={...raw,data:JSON.parse(raw.data)};if(!store.valid(agent,row))continue;validCount++;
    if(recent.length<limit)recent.push(row);const score=rank(row);if(!focused||score>0)keep(experiences,row,score,limit);
  }
  let phaseRole=null,reflectionScanned=0;
  const evidence=id=>{if(!cache.has(id))cache.set(id,store.get(agent,id));return cache.get(id);};
  for(const raw of store.db.prepare('SELECT * FROM human_experience_reflection WHERE agent=? ORDER BY created DESC,id DESC').iterate(agent)){
    reflectionScanned++;const row={...raw,data:JSON.parse(raw.data)};if(!store.reflectionValid(agent,row,evidence))continue;
    if(!phaseRole&&row.data.role?.expiresAt>store.clock())phaseRole={...row.data.role,reflectionId:row.id,inference:true,authorityChanged:false};
    const score=Math.max(0,...row.data.experienceIds.map(id=>rank(evidence(id))))+lexical(row.data.lesson+' '+row.data.nextApproach);
    if(!focused||score>0)keep(strategies,row,score,strategyLimit);
  }
  // Recent outcomes remain visible when nothing matches. Unrelated methods are
  // not silently suggested as relevant merely because they were written last.
  return {experiences:experiences.length?experiences.map(x=>x.row):recent,reflections:strategies.map(x=>x.row),phaseRole,retrieval:{mode:focused?'current-intent-and-behavior':'recent',ranking:'lexical-and-structural-not-semantic-proof',scanned,validCount,reflectionScanned,recentFallback:focused&&!experiences.length,modelDecides:true}};
}
