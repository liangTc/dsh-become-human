import {createHash,randomUUID} from 'node:crypto';
import {recentDialogue} from './dialogue-history.mjs';
import {developmentInput,retrievalTerms} from './knowledge-signals.mjs';

const categories=['topics','decisions','openQuestions','corrections'];
const policy=Object.freeze({version:1,maxChunks:12,maxTurnsPerJob:24,maxInputBytes:24000,maxItemsPerSection:3,maxItemChars:240,maxSourceIdsPerItem:8,maxSerializedOutputBytes:8192,maxTextChars:700,preferredTextChars:350,firstThreshold:2,nextThreshold:4,maxRawTurns:256});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const byteLength=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const textOf=message=>(message?.content??[]).filter(part=>part.type==='text').map(part=>part.text??'').join('');
const ident=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(value);
const secret=value=>/(?:sk-[A-Za-z0-9]{16,}|(?:api.?key|password|密码|密钥|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const fail=code=>{throw new Error(code);};
const outputFail=(field,reason,details={})=>{throw Object.assign(new Error('INVALID_DIALOGUE_SUMMARY_OUTPUT'),{validationDiagnostic:{version:1,field,reason,...details}});};
const clip=(value,count)=>Array.from(value).slice(0,count).join('');
const slot=scope=>scope==='normal'?'normal':'development';
const key=scope=>'rolling-dialogue-summary:'+slot(scope);
const holdKey=scope=>'rolling-dialogue-summary-hold:'+slot(scope);
const interruptKey=scope=>'rolling-dialogue-summary-interrupted:'+slot(scope);
const scopeIsDev=scope=>scope.startsWith('development:');
const distinct=values=>Array.isArray(values)&&values.length===new Set(values).size;

/** Derived conversation checkpoints, separate from owner facts and persona. */
export class RollingDialogueSummary {
  constructor(journal,domain,{history=recentDialogue,clock=()=>Date.now()}={}){this.journal=journal;this.db=journal.db;this.domain=domain;this.history=history;this.clock=clock;}
  admitted(agent){this.journal.assertAdmitted(agent.id);}
  scope(agent,{admittedIds=[],lane='foreground'}={}){
    const users=agent.session.snapshotEvents().filter(e=>e.type==='user/message');
    const current=admittedIds.length?users.filter(e=>admittedIds.includes(e.data.id)):users.slice(-1);
    const dev=e=>this.domain.sourceIsDevelopmentTest?.(agent.id,e.data.id)===true||developmentInput(textOf(e.data));
    if(lane!=='foreground'||!current.some(dev))return 'normal';
    const first=users.findIndex(e=>e===current[0]);let boundary=-1;
    for(let i=0;i<first;i++)if(!dev(users[i]))boundary=i;
    const anchor=users.slice(boundary+1).find(dev)?.data.id;
    return anchor?'development:'+anchor:'normal';
  }
  record(agent,scope){const value=this.journal.value(agent.id,key(scope),null);return value?.version===1&&Array.isArray(value.chunks)?value:null;}
  canonical(agent,row){
    if(!ident(row.id)||!['user','assistant'].includes(row.role)||!Number.isFinite(row.time)||secret(row.text??''))return null;
    if(row.role==='user'){
      const source=this.db.prepare("SELECT id,body,hash,root,status,namespace,kind FROM source_record WHERE agent=? AND id=?").get(agent.id,row.id),published=this.db.prepare("SELECT seq,text,created FROM outbox WHERE agent=? AND kind='user' AND event_key=?").get(agent.id,'user:'+row.id);
      if(!source||source.status!=='active'||source.namespace!=='real'||source.kind!=='user'||source.root!==source.id||source.hash!==hash(source.body)||!this.domain.sourceUsable(agent.id,row.id)||secret(source.body))return null;
      // The durable inbox/outbox time can precede the admitted native event by
      // the input batching delay. Identity + exact body/hash bind the source;
      // use its durable publication order/time, not equality of two clocks.
      if(!published||published.text!==source.body||!Number.isFinite(published.created))return null;
      return {id:row.id,role:'user',time:published.created,order:published.seq,hash:source.hash,text:source.body,developmentOnly:this.domain.sourceIsDevelopmentTest?.(agent.id,row.id)===true||developmentInput(source.body)};
    }
    const source=this.db.prepare("SELECT seq,text,created FROM outbox WHERE agent=? AND kind='assistant' AND event_key=?").get(agent.id,'assistant:'+row.id);
    if(!source||typeof source.text!=='string'||!Number.isFinite(source.created)||secret(source.text))return null;
    return {id:row.id,role:'assistant',time:source.created,order:source.seq,hash:hash(source.text),text:source.text};
  }
  validChunk(agent,chunk,scope,eligibleTurns){
    if(!plain(chunk)||chunk.scope!==scope||!Array.isArray(chunk.turns)||!chunk.turns.length||!Array.isArray(chunk.sources)||!chunk.sources.length)return false;
    const barrier=this.journal.value(agent.id,'memoryContextBarrierAt',0),sources=new Map();
    for(const ref of chunk.sources){const source=this.canonical(agent,ref);if(!source||source.hash!==ref.hash||source.order!==ref.order||source.time!==ref.time||source.time<=barrier)return false;sources.set(ref.id,source);}
    for(const turn of chunk.turns){
      if(!Array.isArray(turn.sourceIds)||!turn.sourceIds.length||turn.sourceIds.some(id=>!sources.has(id)))return false;
      const eligible=eligibleTurns?.get(turn.id);
      if(!eligible||!distinct(eligible.map(row=>row.id))||eligible.length!==turn.sourceIds.length||eligible.some(row=>!turn.sourceIds.includes(row.id)))return false;
      const owners=turn.sourceIds.map(id=>sources.get(id)).filter(row=>row.role==='user');
      // Every owner's dependency is retained even if a model item cites only
      // an assistant reply. Unknown assistant IDs are never owner evidence.
      if(!owners.length||owners.some(row=>row.developmentOnly)!==scopeIsDev(scope))return false;
    }
    return true;
  }
  archive(agent,options={}){
    const scope=this.scope(agent,options),recentTurnLimit=Math.max(1,Math.min(40,options.recentTurnLimit??agent.factory.management?.execution(agent.id).context?.historyLimit??8));
    const rows=this.history(agent,{lane:'foreground',admittedIds:options.admittedIds??[],turnLimit:policy.maxRawTurns});
    const groups=[];
    for(const row of rows){if(!row.dialogueTurnId)continue;let group=groups.at(-1);if(group?.id!==row.dialogueTurnId){group={id:row.dialogueTurnId,rows:[]};groups.push(group);}group.rows.push(row);}
    const expired=groups.slice(0,Math.max(0,groups.length-recentTurnLimit)).flatMap(group=>{
      const sources=group.rows.map(row=>this.canonical(agent,row));if(sources.some(row=>!row)||!sources.some(row=>row.role==='user'))return [];
      if(sources.filter(row=>row.role==='user').some(row=>row.developmentOnly)!==scopeIsDev(scope))return [];
      return [{id:group.id,rows:sources}];
    });
    const eligibleTurns=new Map(groups.map(group=>[group.id,group.rows])),record=this.record(agent,scope),chunks=record?.scope===scope?record.chunks.filter(chunk=>this.validChunk(agent,chunk,scope,eligibleTurns)):[],covered=new Set(chunks.flatMap(chunk=>chunk.turns.map(turn=>turn.id))),retiredThroughSeq=record?.scope===scope?record.retiredThroughSeq??0:0,uncovered=expired.filter(turn=>!covered.has(turn.id)&&Math.max(...turn.rows.map(row=>row.order))>retiredThroughSeq);
    return {scope,recentTurnLimit,record,chunks,expired,uncovered,eligibleTurns,invalidChunks:record?.scope===scope?record.chunks.length-chunks.length:0,boundedRawTurns:groups.length,olderNativeRepliesOutsideScan:rows.coverage?.olderNativeRepliesOutsideScan??0};
  }
  basis(agent,state){return hash({scope:state.scope,expectedVersion:state.record?.revision??0,recentTurnLimit:state.recentTurnLimit,barrier:this.journal.value(agent.id,'memoryContextBarrierAt',0),uncovered:state.uncovered.map(turn=>({id:turn.id,sources:turn.rows.map(row=>({id:row.id,role:row.role,hash:row.hash,order:row.order}))}))});}
  prepare(agent,{admittedIds=[],recentTurnLimit}={}){
    this.admitted(agent);if(!distinct(admittedIds)||admittedIds.some(id=>!ident(id)))fail('INVALID_DIALOGUE_SUMMARY_INPUT');
    const state=this.archive(agent,{admittedIds,recentTurnLimit}),held=this.journal.value(agent.id,holdKey(state.scope),null);
    if(held?.scope===state.scope)return null;
    const threshold=state.chunks.length?policy.nextThreshold:policy.firstThreshold;
    if(state.uncovered.length<threshold&&!state.invalidChunks)return null;
    const turns=[],sources=[];
    for(const turn of state.uncovered.slice(0,policy.maxTurnsPerJob)){
      let count=1200,rows;
      do{rows=turn.rows.map(row=>({id:row.id,role:row.role,time:row.time,text:clip(row.text,count),excerpted:Array.from(row.text).length>count}));count=Math.floor(count/2);}while(byteLength({id:turn.id,rows})>policy.maxInputBytes-1000&&count>=75);
      const candidate=[...turns,{id:turn.id,rows}];if(byteLength({turns:candidate})>policy.maxInputBytes)break;
      turns.push({id:turn.id,rows});for(const row of turn.rows)sources.push({id:row.id,role:row.role,time:row.time,order:row.order,hash:row.hash,turnId:turn.id,developmentOnly:scopeIsDev(state.scope)});
    }
    if(!turns.length)return null;
    const expectedVersion=state.record?.revision??0,basis=this.basis(agent,state),fingerprint=hash({scope:state.scope,expectedVersion,basis,turns:turns.map(turn=>turn.id),sources}),interrupted=this.journal.value(agent.id,interruptKey(state.scope),null);
    if(interrupted?.scope===state.scope&&interrupted.fingerprint===fingerprint)return null;
    return {id:'dialogue-summary:'+fingerprint.slice(0,32),scope:state.scope,expectedVersion,fingerprint,basis,admittedIds:[...admittedIds],recentTurnLimit:state.recentTurnLimit,input:{previous:null,turns},sources,sourceIds:sources.map(row=>row.id),coveredTurnIds:turns.map(turn=>turn.id),backlogTurns:state.uncovered.length-turns.length,maxOutputChars:policy.maxTextChars,outputContract:{topics:[{text:'简短主题',sourceIds:['本批真实来源ID']}],decisions:[],openQuestions:[],corrections:[],onlySourceIds:sources.map(row=>row.id),preferredTotalTextChars:policy.preferredTextChars,maxTotalTextChars:policy.maxTextChars,maxPerSection:policy.maxItemsPerSection,maxItemTextChars:policy.maxItemChars,maxSourceIdsPerItem:policy.maxSourceIdsPerItem,maxSerializedOutputBytes:policy.maxSerializedOutputBytes,outputKeys:categories,onlyOutputKeys:true,assistantIsOwnerFact:false,semanticVerified:false}};
  }
  validateOutput(job,output){
    if(!plain(output))outputFail('output','object-required');
    if(Object.keys(output).some(k=>!categories.includes(k)))outputFail('output','unexpected-fields',{unexpectedFieldCount:Object.keys(output).filter(k=>!categories.includes(k)).length});
    for(const category of categories){if(!Array.isArray(output[category]))outputFail(category,'array-required');if(output[category].length>policy.maxItemsPerSection)outputFail(category,'too-many-items',{actual:output[category].length,maximum:policy.maxItemsPerSection});}
    const allowed=new Set(job.sourceIds),result={};let total=0,count=0;
    for(const category of categories)result[category]=output[category].map((item,index)=>{
      const field=category+'['+index+']';
      if(!plain(item))outputFail(field,'object-required');
      if(Object.keys(item).some(k=>!['text','sourceIds'].includes(k)))outputFail(field,'unexpected-fields');
      if(typeof item.text!=='string'||!item.text.trim())outputFail(field+'.text','nonempty-text-required');
      if(Array.from(item.text).length>policy.maxItemChars)outputFail(field+'.text','text-too-long',{actual:Array.from(item.text).length,maximum:policy.maxItemChars});
      if(secret(item.text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(item.text))outputFail(field+'.text','unsafe-text');
      if(!distinct(item.sourceIds)||!item.sourceIds.length||item.sourceIds.length>policy.maxSourceIdsPerItem)outputFail(field+'.sourceIds','invalid-source-count-or-duplicates',{actual:Array.isArray(item.sourceIds)?item.sourceIds.length:0,maximum:policy.maxSourceIdsPerItem});
      if(item.sourceIds.some(id=>!allowed.has(id)))outputFail(field+'.sourceIds','source-outside-batch',{allowedCount:allowed.size});
      const text=item.text.trim();total+=Array.from(text).length;count++;return {text,sourceIds:[...item.sourceIds]};
    });
    if(!count)outputFail('output','empty-summary');
    if(total>policy.maxTextChars)outputFail('output.text','total-text-too-long',{actual:total,maximum:policy.maxTextChars});
    if(byteLength(result)>policy.maxSerializedOutputBytes)outputFail('output','serialized-output-too-large',{actual:byteLength(result),maximum:policy.maxSerializedOutputBytes});return result;
  }
  commit(agent,job,output){
    this.admitted(agent);
    return this.journal.transaction(()=>{
      const current=this.record(agent,job.scope);
      const lastOwner=agent.session.snapshotEvents().filter(e=>e.type==='user/message').at(-1);
      if(job.admittedIds?.length&&!job.admittedIds.includes(lastOwner?.data.id))fail('STALE_DIALOGUE_SUMMARY');
      const existing=current?.scope===job.scope&&current.chunks.find(chunk=>chunk.fingerprint===job.fingerprint);
      if(existing){
        const state=this.archive(agent,{admittedIds:job.admittedIds,recentTurnLimit:job.recentTurnLimit});
        if(!this.validChunk(agent,existing,job.scope,state.eligibleTurns)||hash(this.validateOutput({sourceIds:existing.sources.map(row=>row.id)},output))!==hash(existing.sections))fail('STALE_DIALOGUE_SUMMARY');
        return this.snapshot(agent,{admittedIds:job.admittedIds,recentTurnLimit:job.recentTurnLimit});
      }
      const fresh=this.prepare(agent,{admittedIds:job.admittedIds,recentTurnLimit:job.recentTurnLimit});
      if(!fresh||fresh.scope!==job.scope||fresh.fingerprint!==job.fingerprint||fresh.expectedVersion!==job.expectedVersion)fail('STALE_DIALOGUE_SUMMARY');
      const sections=this.validateOutput(fresh,output),state=this.archive(agent,{admittedIds:fresh.admittedIds,recentTurnLimit:fresh.recentTurnLimit}),now=this.clock(),chunk={id:randomUUID(),scope:fresh.scope,fingerprint:fresh.fingerprint,created:now,sections,sources:fresh.sources,turns:fresh.input.turns.map(turn=>({id:turn.id,sourceIds:turn.rows.map(row=>row.id)})),excerptedMessages:fresh.input.turns.flatMap(turn=>turn.rows).filter(row=>row.excerpted).length};
      const all=[...state.chunks,chunk],evicted=Math.max(0,all.length-policy.maxChunks),discarded=all.slice(0,evicted),value={version:1,revision:job.expectedVersion+1,scope:job.scope,updated:now,chunks:all.slice(-policy.maxChunks),evictedChunks:(current?.scope===job.scope?current.evictedChunks??0:0)+evicted,evictedTurns:(current?.scope===job.scope?current.evictedTurns??0:0)+discarded.reduce((n,chunk)=>n+chunk.turns.length,0),retiredThroughSeq:Math.max(current?.scope===job.scope?current.retiredThroughSeq??0:0,...discarded.flatMap(chunk=>chunk.sources.map(row=>row.order)))};
      this.journal.put(agent.id,key(job.scope),value);this.journal.put(agent.id,'rolling-dialogue-summary:lastScope',job.scope);this.journal.put(agent.id,holdKey(job.scope),null);this.journal.put(agent.id,interruptKey(job.scope),null);
      this.journal.audit(agent.id,'dialogue-summary-committed',{revision:value.revision,scope:scopeIsDev(job.scope)?'development':'normal',chunkId:chunk.id,sourceTurns:chunk.turns.length,sourceMessages:chunk.sources.length,backlogTurns:job.backlogTurns,evictedChunks:evicted,semanticVerified:false,ownerFactsWritten:false,permissionsChanged:false});return this.snapshot(agent,{admittedIds:job.admittedIds,recentTurnLimit:job.recentTurnLimit});
    });
  }
  fail(agent,job,code){
    this.admitted(agent);if(!job?.scope||!ident(job.id)||!job.fingerprint)return;
    const reason=typeof code==='string'&&/^[A-Z_]{3,80}$/u.test(code)?code:'DIALOGUE_SUMMARY_FAILED';
    this.journal.put(agent.id,holdKey(job.scope),{scope:job.scope,at:this.clock(),jobId:job.id,fingerprint:job.fingerprint,code:reason});
    this.journal.audit(agent.id,'dialogue-summary-held',{code:reason,jobId:job.id,scope:scopeIsDev(job.scope)?'development':'normal',previousSummaryPreserved:true});
  }
  interrupt(agent,job){
    this.admitted(agent);if(!job?.scope||!ident(job.id)||typeof job.fingerprint!=='string'||typeof job.basis!=='string')return;
    const previous=this.journal.value(agent.id,interruptKey(job.scope),null);
    if(previous?.scope===job.scope&&previous.fingerprint===job.fingerprint)return;
    this.journal.put(agent.id,interruptKey(job.scope),{scope:job.scope,fingerprint:job.fingerprint,basis:job.basis,jobId:job.id,admittedIds:[...(job.admittedIds??[])],recentTurnLimit:job.recentTurnLimit,at:this.clock(),count:(previous?.scope===job.scope?previous.count??0:0)+1});
    this.journal.audit(agent.id,'dialogue-summary-interrupted',{jobId:job.id,scope:scopeIsDev(job.scope)?'development':'normal',sameBasisAutomaticRetry:false,scopeHeld:false,previousSummaryPreserved:true});
  }
  allowRetry(agent,scope){
    this.admitted(agent);const scopes=scope?[scope]:['normal',this.scope(agent),this.journal.value(agent.id,'rolling-dialogue-summary:lastScope','normal')];
    let cleared=0,clearedInterruptions=0;for(const current of new Set(scopes)){const held=this.journal.value(agent.id,holdKey(current),null),interrupted=this.journal.value(agent.id,interruptKey(current),null);if(held?.scope===current){this.journal.put(agent.id,holdKey(current),null);cleared++;}if(interrupted?.scope===current){this.journal.put(agent.id,interruptKey(current),null);clearedInterruptions++;}}
    this.journal.audit(agent.id,'dialogue-summary-retry-allowed',{cleared,clearedInterruptions});return this.snapshot(agent);
  }
  pending(agent,{admittedIds=[],maxTurns=3,lane='foreground'}={}){
    this.admitted(agent);if(lane!=='foreground')return [];
    const state=this.archive(agent,{admittedIds}),limit=Number.isInteger(maxTurns)?Math.max(0,Math.min(3,maxTurns)):3;
    if(!limit)return [];
    return state.uncovered.slice(-limit).flatMap(turn=>turn.rows.map(row=>({id:row.id,role:row.role,time:row.time,text:Array.from(row.text).length>4096?clip(row.text,2048)+'\n[中间内容未装入；这是历史摘录]\n'+Array.from(row.text).slice(-2048).join(''):row.text,historyExcerpt:Array.from(row.text).length>4096,dialogueTurnId:turn.id,developmentOnly:scopeIsDev(state.scope),pendingBridge:true,coveredByRollingSummary:false})));
  }
  context(agent,{admittedIds=[],lane='foreground',maxBytes=6144,query=''}={}){
    this.admitted(agent);if(lane!=='foreground'||!Number.isSafeInteger(maxBytes)||maxBytes<512)return null;
    const state=this.archive(agent,{admittedIds}),chunks=state.chunks;if(!chunks.length)return null;
    const terms=retrievalTerms(typeof query==='string'?query.slice(0,1000):'',{limit:24}),items=[];
    for(const chunk of chunks)for(const category of categories)for(const item of chunk.sections[category])items.push({category,item,chunk,score:terms.reduce((n,term)=>n+item.text.toLowerCase().includes(term),0)});
    const priority={corrections:3,decisions:2,openQuestions:1,topics:0};items.sort((a,b)=>(terms.length?b.score-a.score:0)||priority[b.category]-priority[a.category]||b.chunk.created-a.chunk.created);
    const allTurns=new Set(chunks.flatMap(chunk=>chunk.turns.map(turn=>turn.id))),sourceMap=new Map(chunks.flatMap(chunk=>chunk.sources).map(source=>[source.id,source])),sections=Object.fromEntries(categories.map(k=>[k,[]])),selected=new Set(),chunkIds=new Set();
    const base={version:state.record.revision,scope:state.scope,developmentOnly:scopeIsDev(state.scope),kind:'rolling-dialogue-summary',semanticValidation:'unverified-model-summary',truth:'inferred',status:'active',sourceTurnCount:allTurns.size,sourceMessageCount:sourceMap.size,coveredThrough:Math.max(...chunks.flatMap(chunk=>chunk.sources.map(row=>row.time))),updated:state.record.updated,originalsRetained:true,ownerFactsWritten:false,permissionsChanged:false,backlogTurns:state.uncovered.length,evictedChunks:state.record.evictedChunks??0,omittedOlderTurns:state.record.evictedTurns??0,olderNativeRepliesOutsideScan:state.olderNativeRepliesOutsideScan};
    const view=()=>({...base,sections,chunkIds:[...chunkIds],sources:[...selected].map(id=>{const ref=sourceMap.get(id),source=this.canonical(agent,ref);return {id:ref.id,role:ref.role,time:ref.time,hash:ref.hash,turnId:ref.turnId,quote:clip(source.text,maxBytes<=2048?40:120)};}),projection:{includedItems:Object.values(sections).reduce((n,rows)=>n+rows.length,0),omittedItems:items.length-Object.values(sections).reduce((n,rows)=>n+rows.length,0),includedSourceTurnCount:new Set([...selected].map(id=>sourceMap.get(id).turnId)).size,omittedSourceTurnCount:allTurns.size-new Set([...selected].map(id=>sourceMap.get(id).turnId)).size,maxBytes}});
    for(const entry of items){const oldIds=new Set(selected),oldChunks=new Set(chunkIds);sections[entry.category].push(entry.item);for(const id of entry.item.sourceIds)selected.add(id);chunkIds.add(entry.chunk.id);if(byteLength(view())>maxBytes){sections[entry.category].pop();selected.clear();for(const id of oldIds)selected.add(id);chunkIds.clear();for(const id of oldChunks)chunkIds.add(id);}}
    const result=view();return result.projection.includedItems&&byteLength(result)<=maxBytes?result:null;
  }
  snapshot(agent,options={}){
    this.admitted(agent);const scope=this.scope(agent,options),state=this.archive(agent,options),record=state.record,held=this.journal.value(agent.id,holdKey(scope),null),interruption=this.journal.value(agent.id,interruptKey(scope),null),latestOwner=agent.session.snapshotEvents().filter(e=>e.type==='user/message').at(-1),comparison=options.admittedIds?.length||!interruption?.admittedIds?.includes(latestOwner?.data.id)?state:this.archive(agent,{admittedIds:interruption.admittedIds,recentTurnLimit:interruption.recentTurnLimit}),interrupted=interruption?.scope===scope&&interruption.basis===this.basis(agent,comparison),turns=new Set(state.chunks.flatMap(chunk=>chunk.turns.map(turn=>turn.id)));
    return {version:record?.scope===scope?record.revision:0,enabled:true,scope,developmentOnly:scopeIsDev(scope),status:held?.scope===scope?'held':interrupted?'interrupted':state.chunks.length?'active':state.invalidChunks?'invalidated':'empty',updated:record?.scope===scope?record.updated:null,sourceTurnCount:turns.size,sourceMessageCount:new Set(state.chunks.flatMap(chunk=>chunk.sources.map(row=>row.id))).size,chunkCount:state.chunks.length,invalidatedChunks:state.invalidChunks,backlogTurns:state.uncovered.length,evictedChunks:record?.scope===scope?record.evictedChunks??0:0,omittedOlderTurns:record?.scope===scope?record.evictedTurns??0:0,olderNativeRepliesOutsideScan:state.olderNativeRepliesOutsideScan,hold:held?.scope===scope?{code:held.code,at:held.at}:null,interrupted:interrupted?{at:interruption.at,count:interruption.count,waitingFor:'new-expired-basis-or-explicit-retry'}:null,limits:policy,originalsRetained:true,semanticVerified:false,ownerFactsWritten:false,permissionsChanged:false};
  }
}

export const dialogueSummaryPolicy=policy;
