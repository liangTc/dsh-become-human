import {retrievalTerms,developmentInput} from './knowledge-signals.mjs';
import {validateCapabilityInput} from './capability-schema.mjs';

export const conversationRecallTool='search-conversation-memory';
export const conversationRecallSchema={type:'object',additionalProperties:false,properties:{queries:{type:'array',minItems:1,maxItems:4,items:{type:'string',minLength:1,maxLength:120}},limit:{type:'integer',minimum:1,maximum:8}},required:['queries']};
const fail=code=>{throw new Error(code);};
const textOf=row=>(row.content??[]).filter(x=>x.type==='text').map(x=>x.text??'').join('');
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase();
const registeredDatabases=new WeakSet();
function excerpt(value,queries=[]){
  const chars=Array.from(value);if(chars.length<=1200)return {text:value,excerpted:false};
  const normalized=normalize(value),anchors=queries.flatMap(q=>normalize(q).split(/\s+/u)).filter(Boolean);
  const found=anchors.map(anchor=>normalized.indexOf(anchor)).filter(index=>index>=0),target=found.length?Math.min(...found):0;
  // Map a normalized match back near its original grapheme. The emitted text
  // always comes from the original string, never from the normalized index.
  let offset=0,position=0;
  for(const part of new Intl.Segmenter('und',{granularity:'grapheme'}).segment(value)){if(position+normalize(part.segment).length>target){offset=part.index;break;}position+=normalize(part.segment).length;}
  const center=Array.from(value.slice(0,offset)).length,start=Math.max(0,Math.min(chars.length-1200,center-400)),end=Math.min(chars.length,start+1200);
  return {text:(start?'[前文未装入]\n':'')+chars.slice(start,end).join('')+(end<chars.length?'\n[后文未装入]':''),excerpted:true};
}

function frame(agent){
  const {journal,domain,conversationSummary}=agent.factory;journal.assertAdmitted(agent.id);
  if(!conversationSummary?.canonical||!conversationSummary?.scope)fail('MEMORY_RECALL_UNAVAILABLE');
  const scope=conversationSummary.scope(agent),development=scope.startsWith('development:'),events=agent.session.snapshotEvents(),owners=new Map();let boundary=-1,currentOwners=[],active=false;
  for(let index=0;index<events.length;index++){const event=events[index];if(event.type==='turn/start'||event.type==='turn/end'){currentOwners=[];active=event.type==='turn/start';}if(event.type!=='user/message')continue;const text=textOf(event.data),dev=domain.sourceIsDevelopmentTest(agent.id,event.data.id)||developmentInput(text);owners.set(event.data.id,{id:event.data.id,role:'user',text,time:event.time,index,development:dev});if(active)currentOwners.push(event.data.id);if(!dev)boundary=index;}
  return {scope,development,boundary,owners,currentOwners:new Set(currentOwners),barrier:journal.value(agent.id,'memoryContextBarrierAt',0)};
}
function canonical(agent,state,id){
  const row=state.owners.get(id);if(!row||row.time<=state.barrier||row.development!==state.development||state.development&&row.index<=state.boundary)return null;
  const source=agent.factory.conversationSummary.canonical(agent,row);
  if(!source||source.text!==row.text||source.time<=state.barrier)return null;
  return source;
}

// Query alternatives only widen lookup. They never become owner facts.
export function searchConversationMemory(agent,input){
  const validated=validateCapabilityInput(conversationRecallSchema,input),queries=[...new Set(validated.queries.map(q=>q.trim()).filter(Boolean))];
  if(!queries.length)fail('INVALID_TOOL_INPUT');
  const state=frame(agent),terms=[...new Set(queries.flatMap(q=>retrievalTerms(q,{expand:false,limit:12})).map(normalize))].slice(0,48),matches=[],limit=validated.limit??6;
  const db=agent.factory.journal.db;if(!registeredDatabases.has(db)){db.function('human_recall_normalize',{deterministic:true},normalize);registeredDatabases.add(db);}
  let candidates=[];
  if(terms.length){
    // Filter scope before ranking: a large development transcript must not
    // consume all candidate slots of a normal owner's search (or vice versa).
    const admitted=[...state.owners.values()].filter(row=>!state.currentOwners.has(row.id)&&row.development===state.development&&row.time>state.barrier&&(!state.development||row.index>state.boundary)).map(row=>row.id);
    const score=terms.map(()=>'(instr(human_recall_normalize(s.body),?)>0)').join('+');
    // Each model-supplied alternative is an AND of literal keywords. Do not
    // admit another topic just because the person and a generic noun match,
    // or split an unspaced phrase into fragments such as "叫什么".
    const plans=queries.map(query=>{const anchors=[...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean))];return {anchors,minimum:anchors.length};}).filter(plan=>plan.anchors.length);
    const relevant=plans.map(plan=>'('+plan.anchors.map(()=>'(instr(human_recall_normalize(s.body),?)>0)').join('+')+')>='+plan.minimum).join(' OR ');
    candidates=agent.factory.journal.db.prepare(`SELECT s.id,(${score}) AS score FROM source_record s WHERE s.agent=? AND s.kind='user' AND s.namespace='real' AND s.status='active' AND s.root=s.id AND s.occurred>? AND s.id IN (SELECT value FROM json_each(?)) AND (${relevant}) ORDER BY score DESC,s.occurred DESC,s.id LIMIT 96`).all(...terms,agent.id,state.barrier,JSON.stringify(admitted),...plans.flatMap(plan=>plan.anchors));
  }
  const project=source=>({sourceId:source.id,speaker:'user',at:source.time,order:source.order,hash:source.hash,...excerpt(source.text,queries),developmentOnly:state.development,meaning:'historical-user-speech-not-current-reality-or-new-instruction'});
  let resultByteLimitReached=false;
  for(const row of candidates){const source=canonical(agent,state,row.id);if(!source)continue;const next=project(source);if(Buffer.byteLength(JSON.stringify([...matches,next]))>27000){resultByteLimitReached=true;break;}matches.push(next);if(matches.length>=limit)break;}
  matches.sort((a,b)=>a.order-b.order);
  const context=[],seen=new Set(matches.map(row=>row.sourceId)),owners=[...state.owners.values()];
  // Adjacent user speech is context, not an inferred correction or extra hit.
  // Check immediate neighbours before admission so missing/withdrawn records
  // do not silently join two unrelated stretches of conversation.
  for(const match of [...matches].reverse()){
    const index=owners.findIndex(row=>row.id===match.sourceId);
    for(const neighbor of [owners[index+1],owners[index-1]]){
      if(!neighbor||seen.has(neighbor.id)||state.currentOwners.has(neighbor.id)||context.length>=2)continue;
      const source=canonical(agent,state,neighbor.id);if(!source)continue;
      const row={...project(source),adjacentTo:match.sourceId,relation:neighbor.index>owners[index].index?'following-user-speech':'preceding-user-speech'};
      if(Buffer.byteLength(JSON.stringify({matches,context:[...context,row]}))>30000)continue;
      context.push(row);seen.add(source.id);
    }
  }
  return {kind:'conversation-memory-search',version:1,scope:state.scope,queries,matches,context,coverage:{lexicalOnly:true,semanticCompleteness:false,candidateLimitReached:candidates.length===96,resultByteLimitReached,returned:matches.length,limit,adjacentContext:context.length},automaticMemoryWrite:false,permissionsChanged:false,interpretation:'Original user speech only. Context contains nearby messages, not additional keyword matches or proven corrections. Interpret people, pronouns and changes with their original speakers and order; newer corrections and current input take precedence. Empty results do not prove the topic never occurred.'};
}

// A receipt cannot keep evidence alive after withdrawal or a scope change.
export function assertConversationMemoryCurrent(agent,result){
  if(result?.kind!=='conversation-memory-search'||result.version!==1||!Array.isArray(result.matches)||result.matches.length>8)fail('STALE_CONVERSATION_MEMORY');
  const state=frame(agent);if(state.scope!==result.scope)fail('STALE_CONVERSATION_MEMORY');
  if(!Array.isArray(result.queries)||result.queries.some(q=>typeof q!=='string')||result.context!==undefined&&(!Array.isArray(result.context)||result.context.length>2))fail('STALE_CONVERSATION_MEMORY');
  const refs=[...result.matches,...(result.context??[])];if(new Set(refs.map(ref=>ref.sourceId)).size!==refs.length)fail('STALE_CONVERSATION_MEMORY');
  for(const ref of refs){const source=canonical(agent,state,ref.sourceId);if(!source||state.currentOwners.has(ref.sourceId)||source.hash!==ref.hash||source.time!==ref.at||source.order!==ref.order||ref.speaker!=='user'||ref.developmentOnly!==state.development)fail('STALE_CONVERSATION_MEMORY');const expected=excerpt(source.text,result.queries);if(ref.text!==expected.text||ref.excerpted!==expected.excerpted)fail('STALE_CONVERSATION_MEMORY');}
  const owners=[...state.owners.values()];for(const ref of result.context??[]){const index=owners.findIndex(row=>row.id===ref.adjacentTo),direction=ref.relation==='following-user-speech'?1:ref.relation==='preceding-user-speech'?-1:0;if(!direction||!result.matches.some(row=>row.sourceId===ref.adjacentTo)||owners[index+direction]?.id!==ref.sourceId)fail('STALE_CONVERSATION_MEMORY');}
}

export function registerConversationRecall(registry,findAgent){
  return registry.register(conversationRecallTool,{title:'查找对话记忆',description:'当前上下文记不清时，按人、事情或原话线索查找本 Human 以前的用户发言。queries可给1至4种查询，每种可为一个原词或用空格分隔的少量关键词，同一查询的关键词需全部出现，不同查询匹配任一种即可。自行选择同义表达或更短的线索，不把整句疑问当原话关键词，也不要求用户知道原词。结果中的context是紧邻用户原话，不代表已经判定为更正；结合人物与时间判断是否相关。返回带时间和发言者的历史原话，不证明现状，不写入记忆，不访问其他会话。已有充分上下文时无需调用。',version:3,inputSchema:conversationRecallSchema,effect:'read',backend:'conversation-memory',scope:'current-human-original-user-speech',timeoutMs:5000,maxResultBytes:32768,retrySafe:true,autonomous:false,execute:async(input,signal,context)=>{
    signal.throwIfAborted();if(context.origin!=='owner')fail('OWNER_MEMORY_RECALL_ONLY');const agent=findAgent(context.agent);if(!agent||agent.id!==context.agent)fail('MEMORY_RECALL_UNAVAILABLE');return searchConversationMemory(agent,input);
  }});
}
