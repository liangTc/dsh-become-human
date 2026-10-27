import {createHash,randomUUID} from 'node:crypto';
import {retrievalTerms} from './knowledge-signals.mjs';

const DAY=86400000;
const defaults=Object.freeze({enabled:true,intervalMs:DAY,newRecordThreshold:30,hotDays:7,coldDays:30});
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw new Error(code);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const clean=(value,max,required=true)=>typeof value==='string'&&value.trim().length<=max&&(!required||value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)&&!secret(value)?value.trim():fail('INVALID_MEMORY_SUMMARY');
const tiers=new Set(['hot','warm','cold']);
const protectedTypes=new Set(['identity','fact','goal','working']);
const unique=values=>Array.isArray(values)&&values.length===new Set(values).size;
const quoteId=(batchId,source,start,end)=>'MQ-'+hash(['literal-memory-evidence-v1',batchId,source.id,source.hash,start,end]).slice(0,24);

// Model output chooses these IDs, not its own reconstruction of an excerpt.
// Offsets are UTF-16 source-body offsets and are never accepted from the model.
function literalQuote(batchId,source,maxChars){
  if(typeof source?.body!=='string')return null;
  let start=0;while(start<source.body.length&&/\s/u.test(source.body[start]))start++;
  let end=Math.min(source.body.length,start+maxChars);
  if(end<source.body.length&&/[\uD800-\uDBFF]/u.test(source.body[end-1])&&/[\uDC00-\uDFFF]/u.test(source.body[end]))end--;
  while(end>start&&/\s/u.test(source.body[end-1]))end--;
  const text=source.body.slice(start,end);
  if(!text||secret(text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))return null;
  // A one-to-three-character greeting is quotable only as the entire literal
  // source content, never as a permissive short substring of a longer source.
  if(text.length<4&&text!==source.body.trim())return null;
  return {quoteId:quoteId(batchId,source,start,end),sourceId:source.id,text,sourceHash:source.hash,start,end,occurred:source.occurred};
}

// Lifecycle state is an overlay. Source text, memory facts, withdrawal state and
// evidence versions are owned by DomainMemory and are never rewritten here.
export class MemoryLifecycle {
  constructor(journal,domain,{clock=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.clock=clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_memory_overlay(agent TEXT NOT NULL,memory TEXT NOT NULL,version INTEGER NOT NULL,tier TEXT NOT NULL,pinned INTEGER NOT NULL,manual_tier TEXT,importance REAL NOT NULL,last_access INTEGER,access_count INTEGER NOT NULL,duplicate_of TEXT,updated INTEGER NOT NULL,PRIMARY KEY(agent,memory));
      CREATE TABLE IF NOT EXISTS human_memory_batch(id TEXT PRIMARY KEY,agent TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,completed INTEGER,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS human_memory_batch_agent ON human_memory_batch(agent,created);
      CREATE TABLE IF NOT EXISTS human_memory_summary(id TEXT PRIMARY KEY,agent TEXT NOT NULL,batch TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_memory_lifecycle_audit(id TEXT PRIMARY KEY,agent TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);`);
  }
  admitted(agent){this.journal.assertAdmitted(agent);}
  now(agent){return Math.max(this.clock(),this.journal.value(agent,'memoryLifecycleHighWater',0));}
  stamp(agent){const now=this.now(agent);this.journal.put(agent,'memoryLifecycleHighWater',now);return now;}
  table(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  settings(agent){this.admitted(agent);return {version:1,...defaults,...this.journal.value(agent,'memoryLifecycleSettings',{})};}
  configure(agent,input,expectedVersion){
    this.admitted(agent);const old=this.settings(agent);
    if(old.version!==expectedVersion)fail('STALE_MEMORY_LIFECYCLE');
    if(!plain(input)||Object.keys(input).some(key=>!Object.hasOwn(defaults,key)))fail('INVALID_MEMORY_LIFECYCLE_SETTINGS');
    const next={...old,...input,version:old.version+1};
    if(typeof next.enabled!=='boolean'||!Number.isSafeInteger(next.intervalMs)||next.intervalMs<3600000||next.intervalMs>30*DAY||!Number.isSafeInteger(next.newRecordThreshold)||next.newRecordThreshold<5||next.newRecordThreshold>1000||!Number.isSafeInteger(next.hotDays)||next.hotDays<1||next.hotDays>365||!Number.isSafeInteger(next.coldDays)||next.coldDays<=next.hotDays||next.coldDays>3650)fail('INVALID_MEMORY_LIFECYCLE_SETTINGS');
    this.journal.transaction(()=>{this.journal.put(agent,'memoryLifecycleSettings',next);this.audit(agent,'settings-changed',{version:next.version,settings:next});});return next;
  }
  audit(agent,kind,data){const at=this.stamp(agent),id=randomUUID();this.db.prepare('INSERT INTO human_memory_lifecycle_audit VALUES(?,?,?,?,?)').run(id,agent,kind,at,JSON.stringify(data));this.journal.audit(agent,'memory-lifecycle-'+kind,data);}
  source(agent,id){return this.db.prepare('SELECT * FROM source_record WHERE agent=? AND id=?').get(agent,id);}
  validSource(agent,id){const row=this.source(agent,id);return row?.status==='active'&&row.namespace==='real'&&row.hash===hash(row.body)&&this.domain.sourceUsable(agent,id);}
  validMemory(agent,row){return !!row&&row.status==='active'&&row.namespace==='real'&&(row.valid_to===null||row.valid_to>this.now(agent))&&Array.isArray(parse(row.refs))&&parse(row.refs).every(id=>this.validSource(agent,id));}
  memory(agent,id){this.admitted(agent);const row=this.db.prepare('SELECT * FROM memory_record WHERE agent=? AND id=?').get(agent,id);if(!this.validMemory(agent,row))fail('MEMORY_NOT_FOUND');return row;}
  current(agent){return this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND status='active' AND namespace='real' ORDER BY valid_from,id").all(agent).filter(row=>this.validMemory(agent,row));}
  isDevelopment(agent,row){return (parse(row.refs)??[]).some(id=>this.domain.sourceIsDevelopmentTest(agent,id));}
  goalProtected(agent,row){
    if(!this.table('goal_record'))return false;
    const refs=new Set(parse(row.refs)??[]);
    return this.db.prepare("SELECT refs FROM goal_record WHERE agent=? AND status IN ('proposed','active','blocked','paused','needs-evidence','awaiting-review') AND expires>?").all(agent,this.now(agent)).some(goal=>(parse(goal.refs)??[]).some(id=>refs.has(id)||id===row.id));
  }
  initial(agent,row){
    const age=Math.max(0,this.now(agent)-row.valid_from),settings=this.settings(agent),important=protectedTypes.has(row.type)||this.goalProtected(agent,row);
    return {version:1,tier:important?'hot':age<settings.hotDays*DAY?'hot':age<settings.coldDays*DAY?'warm':'cold',pinned:false,manualTier:null,importance:important?1:row.type==='skill'?.6:.4,lastAccess:null,accessCount:0,duplicateOf:null};
  }
  overlay(agent,row){const value=this.db.prepare('SELECT * FROM human_memory_overlay WHERE agent=? AND memory=?').get(agent,row.id);return value?{version:value.version,tier:value.tier,pinned:!!value.pinned,manualTier:value.manual_tier,importance:value.importance,lastAccess:value.last_access,accessCount:value.access_count,duplicateOf:value.duplicate_of}:this.initial(agent,row);}
  saveOverlay(agent,row,value){this.db.prepare('INSERT INTO human_memory_overlay VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent,memory) DO UPDATE SET version=excluded.version,tier=excluded.tier,pinned=excluded.pinned,manual_tier=excluded.manual_tier,importance=excluded.importance,last_access=excluded.last_access,access_count=excluded.access_count,duplicate_of=excluded.duplicate_of,updated=excluded.updated').run(agent,row.id,value.version,value.tier,value.pinned?1:0,value.manualTier??null,value.importance,value.lastAccess??null,value.accessCount,value.duplicateOf??null,this.now(agent));}
  maintain(agent){
    this.admitted(agent);const settings=this.settings(agent);if(!settings.enabled)return {enabled:false,changed:0,...this.status(agent)};
    const rows=this.current(agent),canonical=new Map(),changed=[],summarized=new Set(this.db.prepare("SELECT data FROM human_memory_summary WHERE agent=? AND status='active'").all(agent).map(row=>parse(row.data)).filter(data=>this.summaryValid(agent,data)).flatMap(data=>data.memoryIds));
    this.journal.transaction(()=>{
      for(const row of rows){
        const old=this.overlay(agent,row),next={...old},important=protectedTypes.has(row.type)||this.goalProtected(agent,row),age=Math.max(0,this.now(agent)-Math.max(row.valid_from,old.lastAccess??0));
        const key=hash([row.type,parse(row.payload)]),prior=canonical.get(key);if(!prior)canonical.set(key,row.id);
        next.duplicateOf=prior??null;
        next.importance=important?1:Math.min(.9,(row.type==='skill'?.6:.4)+Math.min(old.accessCount,10)*.025);
        next.tier=old.pinned?'hot':old.manualTier??(important?'hot':age>=settings.coldDays*DAY?'cold':summarized.has(row.id)?'warm':age<settings.hotDays*DAY?'hot':'warm');
        if(!this.db.prepare('SELECT 1 FROM human_memory_overlay WHERE agent=? AND memory=?').get(agent,row.id)||JSON.stringify(old)!==JSON.stringify(next)){next.version=old.version+1;this.saveOverlay(agent,row,next);changed.push(row.id);}
      }
      this.journal.put(agent,'memoryLifecycleLastMaintenanceAt',this.now(agent));this.audit(agent,'maintained',{changed:changed.length,memoryIds:changed.slice(0,100),total:rows.length});
    });return {enabled:true,changed:changed.length,...this.status(agent)};
  }
  annotate(agent,rows,query='',{touch=false}={}){
    this.admitted(agent);if(!Array.isArray(rows)||typeof query!=='string'||query.length>1000)fail('INVALID_MEMORY_QUERY');
    if(touch)this.touch(agent,rows.map(row=>row.id),{query});return rows.map(row=>({...row,lifecycle:this.overlay(agent,row)}));
  }
  recallRank(agent,row,query=''){
    const meta=this.overlay(agent,row),match=query&&retrievalTerms(query).some(term=>JSON.stringify(row.payload).toLowerCase().includes(term));
    return (meta.pinned?50:meta.tier==='hot'?30:meta.tier==='warm'?10:match?5:-30)+(meta.importance??0)*5-(meta.duplicateOf?20:0);
  }
  touch(agent,memoryIds,{query=''}={}){
    this.admitted(agent);if(!unique(memoryIds)||memoryIds.length>100||typeof query!=='string'||query.length>1000)fail('INVALID_MEMORY_QUERY');
    let touched=0;
    this.journal.transaction(()=>{for(const id of memoryIds){const row=this.memory(agent,id),old=this.overlay(agent,row),terms=retrievalTerms(query);if(old.tier==='cold'&&(!query||!terms.some(term=>row.payload.toLowerCase().includes(term))))continue;
      this.saveOverlay(agent,row,{...old,version:old.version+1,lastAccess:this.now(agent),accessCount:old.accessCount+1,...(old.tier==='cold'&&!old.manualTier?{tier:'warm'}:{})});touched++;}});
    return {touched};
  }
  changeTier(agent,memoryId,action,{expectedVersion}={}){
    const row=this.memory(agent,memoryId),old=this.overlay(agent,row);if(old.version!==expectedVersion)fail('STALE_MEMORY_LIFECYCLE');
    const next={...old,version:old.version+1};
    if(action==='pin'){next.pinned=true;next.tier='hot';}
    else if(action==='promote'){next.pinned=false;next.manualTier='hot';next.tier='hot';}
    else if(action==='archive'){if(protectedTypes.has(row.type)||this.goalProtected(agent,row))fail('IMPORTANT_MEMORY_CANNOT_ARCHIVE');next.pinned=false;next.manualTier='cold';next.tier='cold';}
    else if(action==='recover'){next.pinned=false;next.manualTier=null;next.tier='hot';next.lastAccess=this.now(agent);next.accessCount=old.accessCount+1;}
    else fail('INVALID_MEMORY_LIFECYCLE_ACTION');
    this.journal.transaction(()=>{this.saveOverlay(agent,row,next);this.audit(agent,action,{memoryId,version:next.version,priorTier:old.tier,tier:next.tier});});return {memoryId,lifecycle:next};
  }
  pin(agent,id,options){return this.changeTier(agent,id,'pin',options);}
  promote(agent,id,options){return this.changeTier(agent,id,'promote',options);}
  archive(agent,id,options){return this.changeTier(agent,id,'archive',options);}
  recover(agent,id,options){return this.changeTier(agent,id,'recover',options);}
  fingerprint(items){return hash(items.map(item=>({id:item.id,version:item.version,payload:item.payload,refs:item.refs,evidence:item.evidence.map(source=>({id:source.id,hash:source.hash,occurred:source.occurred}))})));}
  evidenceItem(agent,row){const refs=parse(row.refs);return {id:row.id,version:row.version,payload:parse(row.payload),refs,evidence:refs.map(id=>{const source=this.source(agent,id);return {id,text:source.body,hash:source.hash,occurred:source.occurred};})};}
  eligible(agent){
    const used=new Set(this.db.prepare("SELECT data FROM human_memory_summary WHERE agent=? AND status='active'").all(agent).map(row=>parse(row.data)).filter(data=>this.summaryValid(agent,data)).flatMap(data=>data.memoryIds));
    const restored=this.journal.value(agent,'memoryLifecycleRestoredVersions',{});
    return this.current(agent).filter(row=>row.type==='episode'&&!this.isDevelopment(agent,row)&&!this.overlay(agent,row).pinned&&!this.goalProtected(agent,row)&&!used.has(row.id)&&restored?.[row.id]!==row.version);
  }
  due(agent){
    const settings=this.settings(agent),lastAt=this.journal.value(agent,'memoryLifecycleLastSummaryAt',this.journal.value(agent,'memoryLifecycleInitializedAt',this.now(agent))),eligibleCount=this.eligible(agent).length;
    return {due:settings.enabled&&eligibleCount>=2&&(this.now(agent)-lastAt>=settings.intervalMs||eligibleCount>=settings.newRecordThreshold),eligibleCount,lastAt,nextAt:lastAt+settings.intervalMs};
  }
  batch(agent,{limit=12}={}){
    this.admitted(agent);if(!Number.isSafeInteger(limit)||limit<2||limit>12)fail('INVALID_MEMORY_BATCH');if(!this.settings(agent).enabled)return null;
    const rows=this.eligible(agent),selected=rows.slice(0,limit);if(selected.length<2)return null;
    const items=selected.map(row=>this.evidenceItem(agent,row)),batchId=randomUUID(),baseFingerprint=this.fingerprint(items),created=this.now(agent),sourceRefs=[...new Set(items.flatMap(item=>item.refs))],data={batchId,baseFingerprint,created,memoryIds:items.map(item=>item.id),items,sourceRefs,eligibleCount:rows.length,priorOverlays:items.map(item=>({memoryId:item.id,overlay:this.overlay(agent,selected.find(row=>row.id===item.id))}))};
    this.journal.transaction(()=>{this.db.prepare("INSERT INTO human_memory_batch VALUES(?,?,1,'proposed',?,NULL,?)").run(batchId,agent,created,JSON.stringify(data));this.audit(agent,'batch-proposed',{batchId,memoryIds:data.memoryIds,baseFingerprint});});return {...data,version:1};
  }
  rawBatch(agent,batchId){this.admitted(agent);const row=this.db.prepare('SELECT * FROM human_memory_batch WHERE agent=? AND id=?').get(agent,batchId);if(!row)fail('MEMORY_BATCH_NOT_FOUND');return {...row,data:parse(row.data)};}
  failBatch(agent,batchId,code='MEMORY_REVIEW_FAILED'){
    const batch=this.rawBatch(agent,batchId);if(batch.status==='failed')return {batchId,status:batch.status,version:batch.version};if(batch.status!=='proposed')fail('MEMORY_BATCH_NOT_PROPOSED');
    if(typeof code!=='string'||!/^[A-Z][A-Z0-9_]{0,79}$/u.test(code))fail('INVALID_MEMORY_BATCH_ERROR');
    this.journal.transaction(()=>{this.db.prepare("UPDATE human_memory_batch SET status='failed',version=version+1,completed=?,data=? WHERE agent=? AND id=? AND status='proposed'").run(this.now(agent),JSON.stringify({...batch.data,error:code}),agent,batchId);this.audit(agent,'batch-failed',{batchId,code});});return {batchId,status:'failed',version:batch.version+1,error:code};
  }
  currentBatchItems(agent,batch){return batch.data.memoryIds.map(id=>this.evidenceItem(agent,this.memory(agent,id)));}
  quoteCatalog(agent,batchId,{maxChars=240}={}){
    if(!Number.isSafeInteger(maxChars)||maxChars<32||maxChars>240)fail('INVALID_MEMORY_QUOTE_CATALOG');
    const batch=this.rawBatch(agent,batchId);if(batch.status!=='proposed')fail('MEMORY_BATCH_NOT_PROPOSED');
    const items=this.currentBatchItems(agent,batch);if(this.fingerprint(items)!==batch.data.baseFingerprint)fail('STALE_MEMORY_BATCH');
    return [...new Set(items.flatMap(item=>item.refs))].flatMap(id=>{const source=this.source(agent,id);if(!this.validSource(agent,id))fail('STALE_MEMORY_BATCH');const quote=literalQuote(batch.id,source,maxChars);return quote?[quote]:[];});
  }
  commitSummary(agent,input){
    this.admitted(agent);if(!plain(input))fail('INVALID_MEMORY_SUMMARY');const batch=this.rawBatch(agent,input.batchId);
    if(batch.status!=='proposed')fail('MEMORY_BATCH_NOT_PROPOSED');if(input.baseFingerprint!==batch.data.baseFingerprint)fail('STALE_MEMORY_BATCH');
    const items=this.currentBatchItems(agent,batch);if(this.fingerprint(items)!==batch.data.baseFingerprint)fail('STALE_MEMORY_BATCH');
    const title=clean(input.title,160),text=clean(input.text,1200),memoryIds=input.memoryIds??batch.data.memoryIds;
    if(!unique(memoryIds)||memoryIds.length<2||memoryIds.some(id=>!batch.data.memoryIds.includes(id)))fail('INVALID_MEMORY_SUMMARY');
    const selected=items.filter(item=>memoryIds.includes(item.id)),expectedRefs=[...new Set(selected.flatMap(item=>item.refs))],refs=input.refs??expectedRefs;
    if(!unique(refs)||refs.length!==expectedRefs.length||refs.some(id=>!expectedRefs.includes(id)))fail('INVALID_MEMORY_SUMMARY_EVIDENCE');
    if(!Array.isArray(input.quotes)||input.quotes.length<1||input.quotes.length>24)fail('INVALID_MEMORY_SUMMARY_EVIDENCE');
    const quotes=input.quotes.map(quote=>{
      if(!plain(quote)||!refs.includes(quote.sourceId))fail('INVALID_MEMORY_SUMMARY_EVIDENCE');
      const source=this.source(agent,quote.sourceId),excerpt=clean(quote.text,240);
      if(quote.quoteId!==undefined){
        if(Object.keys(quote).some(k=>!['quoteId','sourceId','text','sourceHash','start','end','occurred'].includes(k))||!Number.isSafeInteger(quote.start)||!Number.isSafeInteger(quote.end)||quote.start<0||quote.end<=quote.start||quote.end>source.body.length||quote.end-quote.start>240||quote.sourceHash!==source.hash||quote.quoteId!==quoteId(batch.id,source,quote.start,quote.end)||quote.text!==excerpt||source.body.slice(quote.start,quote.end)!==excerpt||excerpt.length<4&&excerpt!==source.body.trim())fail('UNSUPPORTED_MEMORY_SUMMARY_QUOTE');
        return {sourceId:quote.sourceId,text:excerpt,quoteId:quote.quoteId,sourceHash:source.hash,start:quote.start,end:quote.end};
      }
      // Historical/manual raw-quote callers retain their stricter contract.
      if(excerpt.length<4||!source.body.includes(excerpt))fail('UNSUPPORTED_MEMORY_SUMMARY_QUOTE');return {sourceId:quote.sourceId,text:excerpt};
    });
    if(refs.some(id=>!quotes.some(quote=>quote.sourceId===id)))fail('INCOMPLETE_MEMORY_SUMMARY_EVIDENCE');
    const summaryId=randomUUID(),created=this.now(agent),data={id:summaryId,batchId:batch.id,title,text,memoryIds,refs,quotes,items:selected.map(({payload,evidence,...item})=>({...item,evidence:evidence.map(({text,...source})=>source)})),kind:'derived-model-summary',truth:'inferred',semanticValidation:'unverified-model-inference',temporalValidity:'historical-observations-not-current-state',originalsRetained:true,created};
    this.journal.transaction(()=>{
      this.db.prepare("INSERT INTO human_memory_summary VALUES(?,?,?,1,'active',?,?)").run(summaryId,agent,batch.id,created,JSON.stringify(data));
      const appliedOverlays=[];for(const item of selected){const row=this.memory(agent,item.id),old=this.overlay(agent,row);if(!old.pinned&&!old.manualTier){const next={...old,version:old.version+1,tier:'warm'};this.saveOverlay(agent,row,next);appliedOverlays.push({memoryId:item.id,version:next.version});}}
      this.db.prepare("UPDATE human_memory_batch SET status='completed',version=version+1,completed=?,data=? WHERE agent=? AND id=? AND status='proposed'").run(created,JSON.stringify({...batch.data,summaryId,committedMemoryIds:memoryIds,appliedOverlays}),agent,batch.id);
      this.journal.put(agent,'memoryLifecycleLastSummaryAt',created);this.journal.put(agent,'memoryLifecycleLastRun',{at:created,batchId:batch.id,kind:'summary'});this.audit(agent,'summary-committed',{batchId:batch.id,summaryId,memoryIds,refs,semanticValidation:data.semanticValidation});
    });return data;
  }
  summaryValid(agent,data){
    if(!data||!Array.isArray(data.items)||!data.items.length)return false;
    return data.items.every(item=>{const row=this.db.prepare('SELECT * FROM memory_record WHERE agent=? AND id=?').get(agent,item.id);return this.validMemory(agent,row)&&row.version===item.version&&hash(parse(row.refs))===hash(item.refs)&&item.evidence.every(source=>{const current=this.source(agent,source.id);return this.validSource(agent,source.id)&&current.hash===source.hash&&current.occurred===source.occurred;});});
  }
  summaries(agent,query='',limit=3){
    this.admitted(agent);if(plain(query)){limit=query.limit??3;query=query.query??'';}if(typeof query!=='string'||query.length>1000||!Number.isSafeInteger(limit)||limit<0||limit>12)fail('INVALID_MEMORY_QUERY');
    const terms=retrievalTerms(query);return this.db.prepare("SELECT data FROM human_memory_summary WHERE agent=? AND status='active' ORDER BY created DESC").all(agent).map(row=>parse(row.data)).filter(data=>this.summaryValid(agent,data)).map(data=>({...data,relevance:terms.filter(term=>(data.title+' '+data.text+' '+data.quotes.map(quote=>quote.text).join(' ')).toLowerCase().includes(term)).length})).filter(data=>!query||data.relevance>0).sort((a,b)=>b.relevance-a.relevance||b.created-a.created).slice(0,limit).map(({relevance,...data})=>({...data,evidence:data.refs.map(id=>{const source=this.source(agent,id);return {id,text:source.body,hash:source.hash,occurred:source.occurred};})}));
  }
  restoreBatch(agent,batchId,{expectedVersion}={}){
    const batch=this.rawBatch(agent,batchId);if(batch.version!==expectedVersion)fail('STALE_MEMORY_BATCH');if(batch.status!=='completed')fail('MEMORY_BATCH_NOT_COMPLETED');
    const restored=[],skipped=[];
    this.journal.transaction(()=>{
      const currentBatch=this.rawBatch(agent,batchId);if(currentBatch.version!==expectedVersion||currentBatch.status!=='completed')fail('STALE_MEMORY_BATCH');
      for(const prior of batch.data.priorOverlays??[]){const applied=batch.data.appliedOverlays?.find(item=>item.memoryId===prior.memoryId);if(!applied)continue;const row=this.db.prepare('SELECT * FROM memory_record WHERE agent=? AND id=?').get(agent,prior.memoryId);if(!this.validMemory(agent,row)){skipped.push(prior.memoryId);continue;}
        const old=this.overlay(agent,row);if(old.version!==applied.version){skipped.push(prior.memoryId);continue;}this.saveOverlay(agent,row,{...prior.overlay,version:old.version+1,lastAccess:old.lastAccess,accessCount:old.accessCount});restored.push(row.id);
      }
      // Restoring a batch is an explicit preference for these original memory
      // versions. Do not immediately summarize them again on the next timer.
      // A later owner revision has a new version and becomes eligible normally.
      const oldHeld=this.journal.value(agent,'memoryLifecycleRestoredVersions',{}),held={...(plain(oldHeld)?oldHeld:{})};
      for(const memoryId of batch.data.committedMemoryIds??batch.data.memoryIds){const row=this.db.prepare('SELECT version FROM memory_record WHERE agent=? AND id=?').get(agent,memoryId);if(row)held[memoryId]=row.version;}
      this.journal.put(agent,'memoryLifecycleRestoredVersions',held);
      this.db.prepare("UPDATE human_memory_summary SET status='restored',version=version+1 WHERE agent=? AND batch=? AND status='active'").run(agent,batchId);
      const changed=this.db.prepare("UPDATE human_memory_batch SET status='restored',version=version+1,data=? WHERE agent=? AND id=? AND version=? AND status='completed'").run(JSON.stringify({...batch.data,restoredAt:this.now(agent)}),agent,batchId,expectedVersion);if(changed.changes!==1)fail('STALE_MEMORY_BATCH');this.audit(agent,'batch-restored',{batchId,restored,skipped,heldMemoryIds:batch.data.committedMemoryIds??batch.data.memoryIds,originalEvidenceRestored:false});
    });return {batchId,version:batch.version+1,status:'restored',restored,skipped,originalEvidenceRestored:false};
  }
  status(agent){
    this.admitted(agent);const rows=this.current(agent),held=this.journal.value(agent,'memoryLifecycleRestoredVersions',{}),counts={hot:0,warm:0,cold:0,pinned:0,duplicates:0,total:rows.length,summaries:0,invalidSummaries:0,restoredHeld:0};
    for(const row of rows){const meta=this.overlay(agent,row);if(tiers.has(meta.tier))counts[meta.tier]++;if(meta.pinned)counts.pinned++;if(meta.duplicateOf)counts.duplicates++;if(held?.[row.id]===row.version)counts.restoredHeld++;}
    for(const row of this.db.prepare("SELECT data FROM human_memory_summary WHERE agent=? AND status='active'").all(agent))counts[this.summaryValid(agent,parse(row.data))?'summaries':'invalidSummaries']++;
    const batches=this.db.prepare('SELECT * FROM human_memory_batch WHERE agent=? ORDER BY created DESC,id DESC LIMIT 20').all(agent).map(row=>{const data=parse(row.data),stored=data.summaryId?this.db.prepare('SELECT id,version,status,data FROM human_memory_summary WHERE agent=? AND id=?').get(agent,data.summaryId):null,summary=stored?parse(stored.data):null,valid=!!summary&&stored.status==='active'&&this.summaryValid(agent,summary),memoryRefs=data.items.map(item=>{const memory=this.db.prepare('SELECT version,type,status FROM memory_record WHERE agent=? AND id=?').get(agent,item.id);return {id:item.id,version:item.version,type:memory?.type??'episode',status:memory?.status??'missing',currentVersion:memory?.version??null};});return {id:row.id,version:row.version,status:row.status,created:row.created,completed:row.completed,memoryIds:data.memoryIds,memoryRefs,summaryId:data.summaryId??null,summary:summary?{id:stored.id,version:stored.version,status:stored.status,title:valid?summary.title:'已失效的派生摘要',text:valid?summary.text:'',truth:summary.truth,semanticValidation:summary.semanticValidation,refs:summary.refs,quotes:valid?summary.quotes:[],memoryIds:summary.memoryIds,valid}:null,restoredAt:data.restoredAt??null,error:data.error??null};});
    const audit=this.db.prepare('SELECT id,kind,at,data FROM human_memory_lifecycle_audit WHERE agent=? ORDER BY at DESC,id DESC LIMIT 30').all(agent).map(row=>({...row,data:parse(row.data)}));
    const lastMaintenanceAt=this.journal.value(agent,'memoryLifecycleLastMaintenanceAt',null);
    return {settings:this.settings(agent),counts,lastMaintenanceAt,lastRun:this.journal.value(agent,'memoryLifecycleLastRun',null)??(lastMaintenanceAt?{at:lastMaintenanceAt,batchId:null,kind:'rules'}:null),lastBatch:batches[0]??null,batches,audit,...this.due(agent),policy:{originalsRetained:true,summaryTruth:'inferred',semanticValidation:'unverified-model-inference',archiveDeletesOriginal:false}};
  }
  export(agent){
    this.admitted(agent);const overlays=this.db.prepare('SELECT * FROM human_memory_overlay WHERE agent=? ORDER BY memory').all(agent),summaries=this.db.prepare('SELECT * FROM human_memory_summary WHERE agent=? ORDER BY created,id').all(agent).map(row=>{const data=parse(row.data),valid=row.status==='active'&&this.summaryValid(agent,data);return {...row,data:{...data,...(!valid?{title:'已失效的派生摘要',text:'',quotes:[]}:{}),valid}};});
    const batches=this.db.prepare('SELECT * FROM human_memory_batch WHERE agent=? ORDER BY created,id').all(agent).map(row=>{const data=parse(row.data);return {...row,data:{...data,items:data.items.map(item=>{const current=this.db.prepare('SELECT * FROM memory_record WHERE agent=? AND id=?').get(agent,item.id),valid=this.validMemory(agent,current)&&current.version===item.version;return {...item,payload:valid?item.payload:null,evidence:item.evidence.map(source=>({...source,text:valid&&this.validSource(agent,source.id)&&this.source(agent,source.id).hash===source.hash?source.text:'',valid:!!valid&&this.validSource(agent,source.id)})),valid};})}};});
    return {version:1,settings:this.settings(agent),restoredVersions:this.journal.value(agent,'memoryLifecycleRestoredVersions',{}),overlays,batches,summaries,audit:this.db.prepare('SELECT id,kind,at,data FROM human_memory_lifecycle_audit WHERE agent=? ORDER BY at,id').all(agent).map(row=>({...row,data:parse(row.data)})),restoreSemantics:'Read-only history; withdrawn, expired and revised evidence is not revived. Manually restored memory versions remain excluded from automatic summaries until the original memory is revised.'};
  }
  purgeAgent(agent){for(const table of ['human_memory_overlay','human_memory_batch','human_memory_summary','human_memory_lifecycle_audit'])this.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(agent);}
}
