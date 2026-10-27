import {createHash} from 'node:crypto';
import {preferenceKey,preferenceStatements,preferenceSupported} from './preferences.mjs';
import {retrievalTerms,topicKeys,developmentInput} from './knowledge-signals.mjs';
import {DEFAULT_PERSONA_CORE} from './persona-profile.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TYPES=['identity','working','episode','fact','goal','skill'];
const coreDefault=DEFAULT_PERSONA_CORE;

const secret=text=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/i.test(text);
export class DomainMemory {
  constructor(journal,{clock=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.clock=clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_record(id TEXT PRIMARY KEY,agent TEXT,kind TEXT,namespace TEXT,root TEXT,occurred INTEGER,body TEXT,hash TEXT,status TEXT);
      CREATE TABLE IF NOT EXISTS memory_record(id TEXT PRIMARY KEY,agent TEXT,type TEXT,payload TEXT,truth TEXT,confidence REAL,refs TEXT,roots TEXT,valid_from INTEGER,valid_to INTEGER,status TEXT,version INTEGER,namespace TEXT);
      CREATE TABLE IF NOT EXISTS dependency(source TEXT,dependent TEXT,kind TEXT,PRIMARY KEY(source,dependent));
      CREATE TABLE IF NOT EXISTS extraction_block(agent TEXT,source TEXT,claim_hash TEXT,PRIMARY KEY(agent,source,claim_hash));
      CREATE TABLE IF NOT EXISTS persona_change(id TEXT PRIMARY KEY,agent TEXT,field TEXT,old_value REAL,new_value REAL,roots TEXT,applied INTEGER,status TEXT,base_version INTEGER);
      CREATE TABLE IF NOT EXISTS goal_record(id TEXT PRIMARY KEY,agent TEXT,description TEXT,refs TEXT,status TEXT,expires INTEGER,version INTEGER);
      CREATE INDEX IF NOT EXISTS memory_recall ON memory_record(agent,namespace,type,status,valid_from DESC);`);
  }
  now(agent){const time=Math.max(this.clock(),this.journal.value(agent,'timeHighWater',0));this.journal.put(agent,'timeHighWater',time);return time;}
  ensurePersona(agent){
    if(!this.journal.value(agent,'personaState',null))this.journal.put(agent,'personaState',{version:1,core:this.journal.value(agent,'persona',coreDefault),coreHash:digest(this.journal.value(agent,'persona',coreDefault)),created:this.clock()});
  }
  source(agent,{id,body,kind='user',namespace='real',root=id,occurred=this.clock()}){
    this.journal.assertAdmitted(agent);
    if(!['user','configuration','trusted-result','derived','imported'].includes(kind)||!['real','fictional'].includes(namespace)||typeof body!=='string'||body.length>4096)throw new Error('INVALID_SOURCE');
    if(secret(body))throw new Error('SENSITIVE_MEMORY_REFUSED');
    const old=this.db.prepare('SELECT * FROM source_record WHERE id=?').get(id);
    if(old){if(old.hash!==digest(body)||old.agent!==agent||old.status!=='active')throw new Error('SOURCE_CONFLICT');return old.id;}
    if(kind==='derived'){const original=this.db.prepare("SELECT * FROM source_record WHERE id=? AND agent=? AND status='active'").get(root,agent);if(!original)throw new Error('INVALID_ROOT');root=original.root;}
    this.db.prepare("INSERT INTO source_record VALUES(?,?,?,?,?,?,?,?, 'active')").run(id,agent,kind,namespace,root,occurred,body,digest(body));return id;
  }
  refs(agent,refs){
    if(!Array.isArray(refs)||refs.length<1||refs.length>20||new Set(refs).size!==refs.length)throw new Error('INVALID_EVIDENCE');
    const rows=refs.map(id=>this.db.prepare("SELECT * FROM source_record WHERE id=? AND agent=? AND status='active'").get(id,agent));if(rows.some(r=>!r))throw new Error('INVALID_EVIDENCE');return rows;
  }
  save(agent,{type,payload,refs,truth='factual',namespace='real',validTo=null,confidence=.7}){
    this.journal.assertAdmitted(agent);
    if(!TYPES.includes(type)||!['factual','inferred','fictional'].includes(truth)||!['real','fictional'].includes(namespace)||!payload||typeof payload!=='object'||Array.isArray(payload)||JSON.stringify(payload).length>2048||!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('INVALID_MEMORY');
    if(secret(JSON.stringify(payload)))throw new Error('SENSITIVE_MEMORY_REFUSED');
    const sources=this.refs(agent,refs);
    if(namespace==='real'&&sources.some(s=>s.namespace!=='real'))throw new Error('FICTIONAL_EVIDENCE');
    if(namespace==='real'&&sources.some(s=>this.sourceIsDevelopmentTest(agent,s.id)))throw new Error('DEVELOPMENT_MEMORY_REFUSED');
    if(truth==='factual'&&sources.some(s=>['derived','imported'].includes(s.kind)))throw new Error('UNCONFIRMED_EVIDENCE');
    if(truth==='factual'&&!sources.some(s=>s.kind==='configuration'&&s.body===JSON.stringify(payload)||type==='episode'&&payload.userSaid===s.body||type==='fact'&&payload.entity==='user'&&payload.predicate==='preference'&&s.kind==='user'&&s.namespace==='real'&&s.root===s.id&&this.sourceUsable(agent,s.id)&&preferenceSupported(payload,s.body)))throw new Error('UNSUPPORTED_CLAIM');
    const claim=digest(payload);
    if(sources.some(s=>this.db.prepare('SELECT 1 FROM extraction_block WHERE agent=? AND source=? AND claim_hash=?').get(agent,s.root,claim)))throw new Error('EXTRACTION_BLOCKED');
    const duplicate=this.db.prepare("SELECT id FROM memory_record WHERE agent=? AND type=? AND payload=? AND refs=? AND status='active'").get(agent,type,JSON.stringify(payload),JSON.stringify(refs));if(duplicate)return duplicate.id;
    const time=this.now(agent);if(validTo!==null&&(!Number.isSafeInteger(validTo)||validTo<=time))throw new Error('INVALID_EXPIRY');
    const id=crypto.randomUUID(),roots=[...new Set(sources.map(s=>s.root))];
    this.journal.transaction(()=>{
      if(type==='fact'&&payload.entity&&payload.predicate){
        for(const old of this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND type='fact' AND status='active' AND namespace=?").all(agent,namespace)){
          const p=JSON.parse(old.payload),sameSlot=payload.predicate!=='preference'||preferenceKey(p.value)===preferenceKey(payload.value);if(p.entity===payload.entity&&p.predicate===payload.predicate&&sameSlot){this.db.prepare("UPDATE memory_record SET valid_to=?,status='superseded',version=version+1 WHERE id=?").run(time,old.id);this.invalidate(old.id);}
        }
      }
      this.db.prepare("INSERT INTO memory_record VALUES(?,?,?,?,?,?,?,?,?,?,'active',1,?)").run(id,agent,type,JSON.stringify(payload),truth,confidence,JSON.stringify(refs),JSON.stringify(roots),time,validTo,namespace);
      for(const ref of refs)this.db.prepare('INSERT INTO dependency VALUES(?,?,?)').run(ref,id,'memory');
      this.journal.audit(agent,'memory-saved',{memoryId:id,memoryType:type,truth,refs,namespace});
    });return id;
  }
  observe(agent,message,time=this.clock()){
    if(this.journal.value(agent,'observed:'+message.id,false))return;
    const body=message.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    if(secret(body)||message.source?.kind!=='human')return;
    this.source(agent,{id:message.id,body,occurred:time});
    if(developmentInput(body)){
      // The canonical dialogue remains usable for this turn. An explicitly
      // fictional fixture must not become a real owner's episode or preference.
      this.journal.put(agent,'observed:'+message.id,true);this.journal.audit(agent,'development-input-excluded',{sourceId:message.id,textChars:body.length,scope:'automatic-long-term-memory'});return;
    }
    this.save(agent,{type:'episode',payload:{userSaid:body},refs:[message.id],confidence:1});
    for(const preference of preferenceStatements(body))this.save(agent,{type:'fact',payload:{entity:'user',predicate:'preference',...preference},refs:[message.id]});
    this.journal.put(agent,'observed:'+message.id,true);
  }
  repairPreferenceSlots(agent){
    if(this.journal.value(agent,'preferenceSlotsV2',false))return {restored:0,alreadyApplied:true};
    this.journal.assertAdmitted(agent);
    const rows=this.db.prepare("SELECT * FROM memory_record WHERE agent=? AND type='fact' AND namespace='real' ORDER BY valid_from").all(agent);
    const sources=this.db.prepare("SELECT * FROM source_record WHERE agent=? AND kind='user' AND namespace='real' AND status='active' AND root=id ORDER BY occurred").all(agent);
    const sourceMap=new Map(sources.map(s=>[s.id,s]));
    const revisionTable=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_memory_revision'").get();
    const parsed=r=>{try{return JSON.parse(r.payload);}catch{return null;}};
    const explicit=r=>{const p=parsed(r),refs=JSON.parse(r.refs);return p?.entity==='user'&&p.predicate==='preference'&&r.truth==='factual'&&refs.length===1&&sourceMap.has(refs[0])&&this.sourceUsable(agent,refs[0])&&!this.sourceIsDevelopmentTest(agent,refs[0])&&preferenceSupported(p,sourceMap.get(refs[0]).body);};
    const restored=[];
    this.journal.transaction(()=>{
      for(const row of rows){
        if(row.status!=='superseded'||row.version!==2||!explicit(row)||revisionTable&&this.db.prepare('SELECT 1 FROM human_memory_revision WHERE agent=? AND memory=?').get(agent,row.id))continue;
        const p=parsed(row);if(p.polarity==='dislike')continue;
        // Only repair the known old automatic collision. Manual revisions,
        // deletion, expiry and an explicit later change are never revived.
        const collision=rows.some(r=>r.id!==row.id&&r.valid_from===row.valid_to&&explicit(r)&&parsed(r).polarity!=='dislike'&&preferenceKey(parsed(r).value)!==preferenceKey(p.value));
        const laterChange=sources.some(s=>s.id!==JSON.parse(row.refs)[0]&&s.occurred>=sourceMap.get(JSON.parse(row.refs)[0]).occurred&&preferenceStatements(s.body).some(v=>preferenceKey(v.value)===preferenceKey(p.value)&&v.polarity==='dislike'));
        const active=rows.some(r=>r.status==='active'&&parsed(r)?.predicate==='preference'&&preferenceKey(parsed(r).value)===preferenceKey(p.value));
        if(!collision||laterChange||active)continue;
        this.db.prepare("UPDATE memory_record SET status='active',valid_to=NULL,version=version+1 WHERE agent=? AND id=? AND status='superseded'").run(agent,row.id);row.status='active';restored.push(row.id);
      }
      this.journal.put(agent,'preferenceSlotsV2',true);
      this.journal.audit(agent,'preference-slots-migrated',{version:2,restored:restored.length,memoryIds:restored});
    });return {restored:restored.length};
  }
  list(agent,{type,namespace='real',historical=false,query='',limit=20}={}){
    this.journal.assertAdmitted(agent);if(!Number.isInteger(limit)||limit<1||limit>100||query.length>128)throw new Error('INVALID_QUERY');const now=this.now(agent);
    const rows=this.db.prepare('SELECT * FROM memory_record WHERE agent=? AND namespace=? ORDER BY valid_from DESC').all(agent,namespace).filter(r=>(!type||r.type===type)&&(historical?r.status!=='deleted':r.status==='active'&&(r.valid_to===null||r.valid_to>now))&&JSON.parse(r.refs).every(id=>this.db.prepare("SELECT 1 FROM source_record WHERE id=? AND status='active'").get(id)));
    const scored=rows.map(r=>{const text=r.payload.toLowerCase(),terms=[...new Set(query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{1,2}/g)??[])];return {r,score:query?terms.filter(term=>text.includes(term)).length:1};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.r.valid_from-a.r.valid_from);
    return scored.slice(0,limit).map(({r})=>({...r,payload:JSON.parse(r.payload),refs:JSON.parse(r.refs),roots:JSON.parse(r.roots),evidence:JSON.parse(r.refs).map(id=>{const s=this.db.prepare('SELECT body,hash,occurred FROM source_record WHERE id=?').get(id);return {id,text:s.body,hash:s.hash,occurred:s.occurred};})}));
  }
  invalidate(id){
    const owner=this.db.prepare('SELECT agent FROM memory_record WHERE id=? UNION SELECT agent FROM source_record WHERE id=? LIMIT 1').get(id,id)?.agent;
    if(owner)this.journal.put(owner,'memoryContextBarrierAt',Math.max(this.clock(),this.journal.value(owner,'memoryContextBarrierAt',0)));
    for(const edge of this.db.prepare('SELECT * FROM dependency WHERE source=?').all(id)){
      if(edge.kind==='memory'){this.db.prepare("UPDATE memory_record SET status='invalid',version=version+1 WHERE id=? AND status='active'").run(edge.dependent);this.invalidate(edge.dependent);}
      if(edge.kind==='goal')this.db.prepare("UPDATE goal_record SET status=CASE WHEN status='proposed' THEN 'cancelled' ELSE 'blocked' END,version=version+1 WHERE id=? AND status IN ('proposed','active','blocked','paused','needs-evidence','awaiting-review')").run(edge.dependent);
    }
  }
  forgetRecord(agent,id){
    const row=this.db.prepare("SELECT * FROM memory_record WHERE id=? AND agent=? AND status='active'").get(id,agent);if(!row)throw new Error('MEMORY_NOT_FOUND');
    this.journal.transaction(()=>{for(const root of JSON.parse(row.roots))this.db.prepare('INSERT OR IGNORE INTO extraction_block VALUES(?,?,?)').run(agent,root,digest(JSON.parse(row.payload)));this.invalidate(id);this.db.prepare("UPDATE memory_record SET payload='null',status='deleted',version=version+1 WHERE id=?").run(id);});
    this.development?.reconcile(agent);
  }
  persona(agent){
    this.ensurePersona(agent);const state=this.journal.value(agent,'personaState',null),development=this.development?.snapshot(agent);
    return {version:state.version,core:state.core,coreHash:state.coreHash,created:state.created,developmentVersion:development?.version??1,development:{version:development?.version??1,enabled:development?.settings.enabled??false,traits:this.development?.context(agent)??[]}};
  }
  setCore(agent,text){if(typeof text!=='string'||!text.trim()||text.length>512)throw new Error('INVALID_PERSONA');this.ensurePersona(agent);const s=this.journal.value(agent,'personaState',null);s.core=text.trim();s.coreHash=digest(s.core);s.version++;this.journal.put(agent,'persona',s.core);this.journal.put(agent,'personaState',s);}
  // Retained only for old driver call sites during an upgrade. The former
  // verbosity/humor and keyword-triggered expression mechanisms no longer run.
  applyEligibleEvidence(){return {applied:0,retired:true};}
  enableAuto(){throw new Error('PERSONA_AUTO_REMOVED');}
  evolve(){throw new Error('PERSONA_AUTO_REMOVED');}
  rollback(){throw new Error('PERSONA_AUTO_REMOVED');}
  goal(agent,{description,refs,expires}){
    if(typeof description!=='string'||description.length<1||description.length>512||!Number.isSafeInteger(expires)||expires<=this.now(agent))throw new Error('INVALID_GOAL');this.refs(agent,refs);
    if(this.db.prepare("SELECT count(*) AS n FROM goal_record WHERE agent=? AND status IN ('proposed','active','blocked','paused','needs-evidence','awaiting-review') AND expires>?").get(agent,this.now(agent)).n>=8)throw new Error('GOAL_LIMIT');
    const id=crypto.randomUUID();this.journal.transaction(()=>{this.db.prepare("INSERT INTO goal_record VALUES(?,?,?,?,'proposed',?,1)").run(id,agent,description,JSON.stringify(refs),expires);for(const ref of refs)this.db.prepare('INSERT INTO dependency VALUES(?,?,?)').run(ref,id,'goal');});return id;
  }
  sourceUsable(agent,id){
    const s=this.db.prepare('SELECT root,status FROM source_record WHERE agent=? AND id=?').get(agent,id);
    // Session events that have never been extracted are still valid dialogue.
    // A corrected/forgotten source must not re-enter through recent raw chat.
    return !s||s.status==='active'&&!this.db.prepare('SELECT 1 FROM extraction_block WHERE agent=? AND source=?').get(agent,s.root);
  }
  sourceIsDevelopmentTest(agent,id){
    // Read-only classification: records remain visible in the memory manager.
    // A derived source cannot launder a fixture by replacing its prose. Public
    // trusted-result text mentioning a software test is not an owner fixture.
    const seen=new Set();
    for(let depth=0;typeof id==='string'&&!seen.has(id)&&depth<32;depth++){
      seen.add(id);const row=this.db.prepare('SELECT id,kind,body,root FROM source_record WHERE agent=? AND id=?').get(agent,id);if(!row)return false;
      if(row.kind==='user'&&developmentInput(row.body))return true;
      if(row.kind==='configuration'){
        let data;try{data=JSON.parse(row.body);}catch{}
        if(data&&typeof data==='object'&&!Array.isArray(data)&&(data.developmentOnly===true||data.fixture===true||typeof data.predicate==='string'&&/^(?:p\d+|dev|fixture|acceptance)[_-]test(?:[_-]|$)/iu.test(data.predicate)))return true;
      }
      if(!row.root||row.root===row.id)return false;id=row.root;
    }
    return false;
  }
  contextEvidenceUsable(agent,row){
    // Do not rewrite/deactivate old memories to repair model context. Check the
    // current evidence on every recall so corrections and withdrawal stay live.
    let refs,payload;try{refs=typeof row.refs==='string'?JSON.parse(row.refs):row.refs;payload=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;}catch{return false;}
    if(!Array.isArray(refs)||!refs.length||!payload||typeof payload!=='object'||Array.isArray(payload))return false;
    const sources=refs.map(ref=>this.db.prepare('SELECT id,kind,body,status,namespace,root FROM source_record WHERE agent=? AND id=?').get(agent,ref));
    if(sources.some(source=>!source||source.status!=='active'||source.namespace!=='real'||!this.sourceUsable(agent,source.id)||this.sourceIsDevelopmentTest(agent,source.id)))return false;
    // Older extractors treated questions such as "我喜欢怎样的回答？" as
    // preferences. A factual preference must satisfy today's source contract;
    // exact explicit configuration is still allowed and is not reinterpreted.
    if(row.type==='fact'&&row.truth==='factual'&&payload.entity==='user'&&payload.predicate==='preference'&&!sources.some(source=>source.kind==='configuration'&&source.body===JSON.stringify(payload)||source.kind==='user'&&source.root===source.id&&preferenceSupported(payload,source.body)))return false;
    return true;
  }
  eventOverviews(agent,{query='',limit=3,excludeRefs=[]}={}){
    if(!Number.isInteger(limit)||limit<0||limit>8||typeof query!=='string'||query.length>1000)throw new Error('INVALID_QUERY');
    if(!limit)return [];
    const now=this.now(agent),excluded=new Set(excludeRefs),terms=retrievalTerms(query),groups=new Map();
    const rows=this.db.prepare("SELECT m.id,m.refs,m.valid_from,s.id AS source_id,s.body,s.occurred FROM memory_record m JOIN source_record s ON s.agent=m.agent AND EXISTS(SELECT 1 FROM json_each(m.refs) r WHERE r.value=s.id) WHERE m.agent=? AND m.type='episode' AND m.namespace='real' AND m.status='active' AND (m.valid_to IS NULL OR m.valid_to>?) AND s.kind='user' AND s.namespace='real' AND s.status='active' AND s.root=s.id ORDER BY s.occurred DESC,m.id LIMIT 128").all(agent,now);
    for(const row of rows){
      if(excluded.has(row.source_id)||!this.sourceUsable(agent,row.source_id)||this.sourceIsDevelopmentTest(agent,row.source_id))continue;
      let refs;try{refs=JSON.parse(row.refs);}catch{continue;}
      if(!refs.every(ref=>this.sourceUsable(agent,ref)&&!this.sourceIsDevelopmentTest(agent,ref)&&this.db.prepare("SELECT 1 FROM source_record WHERE agent=? AND id=? AND status='active'").get(agent,ref)))continue;
      const score=terms.filter(t=>row.body.toLowerCase().includes(t)).length;
      if(this.lifecycle){const memory=this.db.prepare('SELECT id,type,payload,valid_from FROM memory_record WHERE agent=? AND id=?').get(agent,row.id);if(memory&&this.lifecycle.overlay(agent,memory).tier==='cold'&&!score)continue;}
      const topics=topicKeys(row.body),key=Math.floor(row.occurred/86400000)+':'+(topics[0]??'conversation');
      let group=groups.get(key);if(!group){group={version:1,summaryKind:'evidence-excerpts',topicHints:topics,firstObservedAt:row.occurred,lastObservedAt:row.occurred,currentState:'unconfirmed',semanticSummary:false,sourceIds:[],memoryIds:[],excerpts:[],_score:0};groups.set(key,group);}
      if(group.sourceIds.includes(row.source_id)||group.excerpts.length>=3)continue;
      group.sourceIds.push(row.source_id);group.memoryIds.push(row.id);group.excerpts.push({sourceId:row.source_id,at:row.occurred,text:Array.from(row.body).slice(0,160).join(''),excerptOnly:true});group.firstObservedAt=Math.min(group.firstObservedAt,row.occurred);group.lastObservedAt=Math.max(group.lastObservedAt,row.occurred);group._score+=score;
    }
    return [...groups.values()].sort((a,b)=>b._score-a._score||b.lastObservedAt-a.lastObservedAt).slice(0,limit).map(({_score,...group})=>({...group,retrieval:_score?'keyword-or-alias-match':'recent-evidence',temporalValidity:'historical-observations-not-current-state'}));
  }
  memoryAnnotations(agent,row,active){
    const payload=row.payload,preference=row.type==='fact'&&payload?.predicate==='preference';
    const sameSlot=other=>other.id!==row.id&&other.type===row.type&&payload?.entity&&other.payload?.entity===payload.entity&&payload.predicate&&other.payload.predicate===payload.predicate&&(!preference||preferenceKey(other.payload.value)===preferenceKey(payload.value));
    const conflict=active.filter(sameSlot).filter(other=>JSON.stringify(other.payload)!==JSON.stringify(payload)).slice(0,4).map(other=>other.id);
    const previous=[];
    if(row.type==='fact'&&payload?.entity&&payload?.predicate)for(const r of this.db.prepare("SELECT id,type,payload,truth,refs FROM memory_record WHERE agent=? AND type='fact' AND namespace='real' AND status='superseded' ORDER BY valid_from DESC LIMIT 128").all(agent)){
      if(!this.contextEvidenceUsable(agent,r))continue;
      let p;try{p=JSON.parse(r.payload);}catch{continue;}
      if(p?.entity===payload.entity&&p.predicate===payload.predicate&&(!preference||preferenceKey(p.value)===preferenceKey(payload.value))){previous.push(r.id);if(previous.length===4)break;}
    }
    return {temporalValidity:{kind:row.type==='episode'?'historical-observation':'valid-source-record',validFrom:row.valid_from,validTo:row.valid_to,currentRealityVerified:false},conflict:{status:conflict.length?'possible-conflict':previous.length?'supersedes-prior-record':'none-observed',relatedMemoryIds:conflict,priorMemoryIds:previous,resolution:'source-and-time-aware-not-semantic-verification'}};
  }
  recall(agent,{query='',limit=8,excludeEpisodeRefs=[],excludeTypes=[]}={}){
    this.journal.assertAdmitted(agent);if(!Number.isInteger(limit)||limit<1||limit>100||typeof query!=='string'||query.length>1000)throw new Error('INVALID_QUERY');
    const terms=retrievalTerms(query);
    const now=this.now(agent),excluded=new Set(excludeEpisodeRefs),rows=[];
    // Each category has its own bounded candidate pool. A burst of episodes
    // cannot evict long-term facts from retrieval. This is lexical retrieval,
    // not an embedding model or a claim of semantic completeness.
    for(const type of TYPES){if(excludeTypes.includes(type))continue;
      const relevance=terms.length?'('+terms.map(()=>'(instr(lower(payload),?)>0)').join('+')+') DESC,':'';
      for(const r of this.db.prepare("SELECT id,type,payload,truth,confidence,refs,version,valid_from,valid_to FROM memory_record WHERE agent=? AND namespace='real' AND type=? AND status='active' AND (valid_to IS NULL OR valid_to>?) ORDER BY "+relevance+"valid_from DESC,id DESC LIMIT 512").all(agent,type,now,...terms)){
        const refs=JSON.parse(r.refs);if(!this.contextEvidenceUsable(agent,r))continue;
        if(type==='episode'&&refs.some(ref=>excluded.has(ref)))continue;
        const payload=JSON.parse(r.payload),text=r.payload.toLowerCase(),matched=terms.reduce((n,term)=>n+(text.includes(term)?1:0),0);
        const candidate={...r,payload,refs,score:matched,layer:['identity','fact'].includes(type)?'long-term':type==='episode'?'episodic':type==='skill'?'learning':'working'},annotated=this.lifecycle?.annotate(agent,[candidate],query,{touch:false})[0]??candidate;
        if(annotated.lifecycle?.tier==='cold'&&!matched)continue;
        rows.push({...annotated,_lifecycleRank:this.lifecycle?.recallRank(agent,candidate,query)??0});
      }
    }
    const recent=(a,b)=>b.score-a.score||b._lifecycleRank-a._lifecycleRank||b.valid_from-a.valid_from||a.id.localeCompare(b.id,'en');
    rows.sort(recent);
    const stable=rows.filter(r=>['identity','fact'].includes(r.type)),chosen=stable.slice(0,Math.min(2,limit)),ids=new Set(chosen.map(r=>r.id));
    // Goals/working facts and relevant knowledge outrank unrelated chat. Keep
    // a small recent episodic tail only after durable/relevant information.
    const rest=rows.filter(r=>!ids.has(r.id)).sort((a,b)=>((b.score>0?100:0)+(['identity','fact','goal','working'].includes(b.type)?10:0)+(b.type==='skill'?2:0)+b._lifecycleRank)-((a.score>0?100:0)+(['identity','fact','goal','working'].includes(a.type)?10:0)+(a.type==='skill'?2:0)+a._lifecycleRank)||recent(a,b));
    return [...chosen,...rest].slice(0,limit).map(({score,_lifecycleRank,...r})=>({...r,...this.memoryAnnotations(agent,r,rows),retrieval:score?'keyword-or-alias-match':['identity','fact'].includes(r.type)?'important-fact':'recent-background'}));
  }
  context(agent,options={}){
    const {includePersona=true,...recall}=options,persona=includePersona?this.persona(agent):null,now=this.now(agent);
    const goals=this.db.prepare("SELECT id,description,status,expires,version,refs FROM goal_record WHERE agent=? AND status IN ('proposed','active','blocked','needs-evidence','awaiting-review') AND expires>? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'needs-evidence' THEN 1 WHEN 'awaiting-review' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,expires,id LIMIT 8").all(agent,now).filter(g=>JSON.parse(g.refs).every(ref=>this.db.prepare("SELECT 1 FROM source_record WHERE id=? AND agent=? AND status='active'").get(ref,agent)&&this.sourceUsable(agent,ref)&&!this.sourceIsDevelopmentTest(agent,ref))).map(g=>({...g,refs:JSON.parse(g.refs)}));
    // Inspect a bounded larger candidate pool before taking two summaries:
    // filtered legacy test summaries must not starve valid older summaries.
    const summaries=(this.lifecycle?.summaries(agent,recall.query??'',12)??[]).filter(summary=>{
      if(!Array.isArray(summary.refs)||summary.refs.some(ref=>this.sourceIsDevelopmentTest(agent,ref)||!this.sourceUsable(agent,ref)))return false;
      if(!Array.isArray(summary.memoryIds)||!summary.memoryIds.every(id=>{const memory=this.db.prepare('SELECT id,type,payload,truth,refs FROM memory_record WHERE agent=? AND id=?').get(agent,id);return memory&&this.contextEvidenceUsable(agent,memory);}))return false;
      if(recall.query)return true;
      return summary.memoryIds.every(id=>{const memory=this.db.prepare('SELECT id,type,payload,valid_from FROM memory_record WHERE agent=? AND id=?').get(agent,id);return memory&&this.lifecycle.overlay(agent,memory).tier!=='cold';});
    }).slice(0,2).map(summary=>({id:summary.id,batchId:summary.batchId,title:summary.title,text:summary.text,kind:'derived-model-summary',truth:'inferred',semanticValidation:'unverified-model-inference',temporalValidity:summary.temporalValidity,created:summary.created,memoryIds:summary.memoryIds,refs:summary.refs,quotes:summary.quotes.slice(0,4).map(quote=>({sourceId:quote.sourceId,text:quote.text.slice(0,160)})),originalsRetained:true,ownerFact:false}));
    return {...(persona?{persona:{version:persona.version,core:persona.core,developmentVersion:persona.developmentVersion,development:persona.development}}:{}),memories:this.recall(agent,{limit:this.journal.value(agent,'humanExecution',{}).context?.memoryLimit??8,...recall}),summaries,goals};
  }
  purgeAgent(agent){this.development?.purge(agent);this.lifecycle?.purgeAgent(agent);if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_action'").get())this.db.prepare('DELETE FROM human_action WHERE agent=?').run(agent);if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_goal_plan'").get())this.db.prepare('DELETE FROM human_goal_plan WHERE agent=?').run(agent);for(const table of ['source_record','memory_record','extraction_block','persona_change','goal_record'])this.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(agent);this.db.prepare('DELETE FROM dependency WHERE source NOT IN (SELECT id FROM source_record) AND source NOT IN (SELECT id FROM memory_record)').run();}
}
