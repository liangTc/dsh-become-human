import {createHash,randomUUID} from 'node:crypto';
import {developmentInput} from './knowledge-signals.mjs';

const DAY=86400000;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sourceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw new Error(code);};
const ident=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value);
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.trim().length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)&&!secret(value)?value.trim():fail('INVALID_PERSONA_DEVELOPMENT');
const round=value=>Math.round(value*1000000)/1000000;
const clamp=value=>Math.max(-.6,Math.min(.6,value));
const boundaryRisk=value=>/(?:^|[\s_.:-])(?:identity|relationship|role|duties|permissions?|credentials?|api|provider|model|ownerfacts?)(?:$|[\s_.:-])/iu.test(value)||/(?:姓名|名字|性别|年龄|核心人格|核心身份|角色身份|关系身份|身份设定|角色设定|职责|权限|密钥|凭据|模型配置|API配置|主人的(?:性格|爱好|偏好|事实)|主人(?:喜欢|讨厌|是|住在)|用户(?:喜欢|讨厌|是|住在)|我(?:现在|以后|从此|已经)?是(?:真人|人类|主人|用户|男友|女友|丈夫|妻子|助理|助手)|我(?:现在|以后|从此|已经)?叫\S{1,32}|忽略(?:之前|以前|系统|所有).{0,8}(?:规则|指令|限制)|(?:ignore|override)\s+(?:all\s+)?(?:previous|system|instructions?|rules?))/iu.test(value);

export const personaDevelopmentPolicy=Object.freeze({version:1,kinds:['interest','disposition','habit'],reviewIntervalMs:DAY,minIndependentRoots:3,minEvidenceSpanMs:DAY,minConfidence:.7,maxItems:3,maxTraits:24,maxStrength:.6,maxStep:.1,historyLimit:64,ownerFactsWritten:false,stableCoreChanged:false,permissionsChanged:false});

// This store records evidence-linked, reversible agent tendencies. It never
// edits a profile, relationship, owner fact, tool grant, model route or prompt.
// The existing driver owns scheduling and model calls; reads call no model.
export class PersonaDevelopment {
  constructor(journal,domain,{clock=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.clock=clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_persona_development_state(agent TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL,last_reviewed INTEGER,last_applied INTEGER);
      CREATE TABLE IF NOT EXISTS human_persona_development_review(agent TEXT NOT NULL,id TEXT NOT NULL,request_hash TEXT NOT NULL,base_version INTEGER NOT NULL,result_version INTEGER NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(agent,id));
      CREATE TABLE IF NOT EXISTS human_persona_development_change(id TEXT PRIMARY KEY,agent TEXT NOT NULL,review_id TEXT NOT NULL,kind TEXT NOT NULL,trait_key TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS human_persona_development_agent ON human_persona_development_change(agent,status,created);`);
  }
  admitted(agent){if(!ident(agent))fail('INVALID_PERSONA_SESSION');this.journal.assertAdmitted(agent);if(!this.journal.get(agent))fail('PERSONA_SESSION_NOT_FOUND');}
  table(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  now(agent){const time=this.clock();return Math.max(Number.isSafeInteger(time)&&time>=0?time:0,this.journal.value(agent,'personaDevelopmentTimeHighWater',0));}
  rawSettings(agent){this.admitted(agent);return this.db.prepare('SELECT * FROM human_persona_development_state WHERE agent=?').get(agent)??{agent,version:1,enabled:0,last_reviewed:null,last_applied:null};}
  settings(agent){const state=this.rawSettings(agent);return {enabled:!!state.enabled,reviewIntervalMs:DAY,version:state.version,lastReviewedAt:state.last_reviewed,lastAppliedAt:state.last_applied};}
  writeState(agent,state){this.db.prepare('INSERT INTO human_persona_development_state VALUES(?,?,?,?,?) ON CONFLICT(agent) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,last_reviewed=excluded.last_reviewed,last_applied=excluded.last_applied').run(agent,state.version,state.enabled?1:0,state.last_reviewed,state.last_applied);this.journal.put(agent,'personaDevelopmentTimeHighWater',this.now(agent));}
  configure(agent,input){
    this.admitted(agent);if(!plain(input)||Object.keys(input).some(key=>!['enabled','expectedVersion'].includes(key))||typeof input.enabled!=='boolean')fail('INVALID_PERSONA_DEVELOPMENT_SETTINGS');
    return this.journal.transaction(()=>{this.reconcile(agent);const state=this.rawSettings(agent);if(input.expectedVersion!==undefined&&input.expectedVersion!==state.version)fail('STALE_PERSONA_DEVELOPMENT');if(!!state.enabled===input.enabled)return this.settings(agent);state.enabled=input.enabled?1:0;state.version++;this.writeState(agent,state);this.journal.audit(agent,'persona-development-configured',{enabled:input.enabled,version:state.version,stableCoreChanged:false,permissionsChanged:false});return this.settings(agent);});
  }
  memoriesForSource(agent,sourceId,now){
    if(!this.table('memory_record'))return [];
    return this.db.prepare("SELECT id,version,payload,refs,valid_from,valid_to FROM memory_record WHERE agent=? AND namespace='real' AND status='active' AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) AND EXISTS(SELECT 1 FROM json_each(refs) r WHERE r.value=?) ORDER BY id").all(agent,now,now,sourceId).filter(row=>{
      const refs=parse(row.refs);return Array.isArray(refs)&&refs.length&&refs.every(id=>typeof id==='string'&&this.db.prepare("SELECT 1 FROM source_record WHERE agent=? AND id=? AND namespace='real' AND status='active'").get(agent,id)&&this.domain.sourceUsable(agent,id));
    });
  }
  sourceEvidence(agent,id){
    if(!ident(id)||!this.table('source_record'))return null;
    const now=this.now(agent),source=this.db.prepare("SELECT * FROM source_record WHERE agent=? AND id=? AND status='active' AND namespace='real'").get(agent,id);
    if(!source||!Number.isSafeInteger(source.occurred)||source.occurred<0||source.occurred>now||typeof source.body!=='string'||source.hash!==sourceHash(source.body)||secret(source.body)||!this.domain.sourceUsable(agent,id))return null;
    const memories=this.memoriesForSource(agent,id,now);if(!memories.length)return null;
    const memoryVersions=memories.map(row=>({id:row.id,version:row.version,hash:hash({payload:parse(row.payload),refs:parse(row.refs)}),validTo:row.valid_to}));
    if(source.kind==='user'){
      if(source.root!==source.id||developmentInput(source.body))return null;
      return {id,root:source.id,kind:'owner-source',hash:source.hash,occurred:source.occurred,memoryVersions,noteVersions:[],excerpt:source.body.slice(0,600),ownerPreference:false};
    }
    if(!['imported','trusted-result'].includes(source.kind)||!this.table('learning_note'))return null;
    const body=parse(source.body),notes=this.db.prepare("SELECT id,memory_id,data,created FROM learning_note WHERE agent=? AND source_id=? AND status='active' ORDER BY id").all(agent,id),valid=[];
    if(!body||typeof body.excerpt!=='string'||typeof body.url!=='string')return null;
    let url;try{url=new URL(body.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.hash='';}catch{return null;}
    for(const note of notes){
      const data=parse(note.data);if(!data||!memories.some(row=>row.id===note.memory_id)||developmentInput([data.title,data.researchQuestion].filter(value=>typeof value==='string').join(' '))||!Array.isArray(data.claims)||!data.claims.length||!data.claims.every(claim=>typeof claim?.text==='string'&&claim.text.trim()&&typeof claim.quote==='string'&&claim.quote.length>=8&&body.excerpt.includes(claim.quote))||data.source?.digest!==body.digest||data.source?.url!==body.url)continue;
      if(data.taskId&&this.table('autonomy_task')){const task=this.db.prepare('SELECT checkpoint FROM autonomy_task WHERE agent=? AND id=?').get(agent,data.taskId),checkpoint=parse(task?.checkpoint);if(developmentInput([checkpoint?.plan?.question,checkpoint?.goal?.description].filter(value=>typeof value==='string').join(' ')))continue;}
      valid.push({id:note.id,hash:hash(data),memoryId:note.memory_id});
    }
    if(!valid.length)return null;
    // Re-fetching the same page creates neither an independent experience nor
    // another vote. Versions and evidence remain separately traceable.
    return {id,root:'learning:'+url.href,kind:'learning-source',hash:source.hash,occurred:source.occurred,memoryVersions:memoryVersions.filter(row=>valid.some(note=>note.memoryId===row.id)),noteVersions:valid,excerpt:body.excerpt.slice(0,600),ownerPreference:false};
  }
  evidence(agent,{limit=24}={}){
    this.admitted(agent);if(!Number.isInteger(limit)||limit<1||limit>64)fail('INVALID_PERSONA_EVIDENCE_QUERY');if(!this.table('source_record'))return [];
    const base="SELECT id FROM source_record WHERE agent=? AND namespace='real' AND status='active' AND kind IN ('user','imported','trusted-result')",now=this.now(agent),rows=new Map();
    const collect=sources=>{const values=[];for(const source of sources){let row=rows.get(source.id);if(row===undefined){row=this.sourceEvidence(agent,source.id);rows.set(source.id,row);}if(row)values.push(row);}return values;};
    const recent=collect(this.db.prepare(base+' ORDER BY occurred DESC,id DESC LIMIT 256').all(agent)),prior=collect(this.db.prepare(base+' AND occurred<=? ORDER BY occurred DESC,id DESC LIMIT 256').all(agent,now-DAY)),oldest=collect(this.db.prepare(base+' AND occurred<=? ORDER BY occurred,id LIMIT 256').all(agent,now-DAY)),selected=[],roots=new Set();
    const add=(pool,maximum)=>{let added=0;for(const row of pool){if(selected.length===limit||added===maximum)break;if(roots.has(row.root))continue;roots.add(row.root);selected.push(row);added++;}};
    // Dense recent dialogue must not permanently crowd out older independent
    // evidence. These are candidates, not claims that every source supports a
    // particular trait; the reviewer still has to select and explain its refs.
    add(recent,Math.ceil(limit/2));add(oldest,Math.ceil((limit-selected.length)/2));add(prior,limit-selected.length);add(recent,limit-selected.length);add(oldest,limit-selected.length);
    return selected.map(row=>({id:row.id,root:row.root,kind:row.kind,occurred:row.occurred,excerpt:row.excerpt,memoryIds:row.memoryVersions.map(v=>v.id),noteIds:row.noteVersions.map(v=>v.id),version:row.hash,ownerPreference:false}));
  }
  fingerprint(row){const {excerpt,...rest}=row;return hash(rest);}
  changes(agent){return this.db.prepare('SELECT * FROM human_persona_development_change WHERE agent=? ORDER BY created,id').all(agent).map(row=>({...parse(row.data),id:row.id,reviewId:row.review_id,kind:row.kind,key:row.trait_key,status:row.status,created:row.created,updated:row.updated}));}
  reconcile(agent){
    this.admitted(agent);const invalid=[];
    for(const change of this.changes(agent).filter(row=>['active','observing'].includes(row.status))){
      const valid=this.changeEvidenceValid(agent,change);
      if(!valid)invalid.push(change);
    }
    if(!invalid.length)return false;
    this.journal.transaction(()=>{const now=this.now(agent),state=this.rawSettings(agent);for(const change of invalid){const data={...this.redactedChange(change),statusReason:'evidence-withdrawn-expired-or-revised',invalidatedAt:now};this.db.prepare("UPDATE human_persona_development_change SET status='invalid',data=?,updated=? WHERE agent=? AND id=? AND status IN ('active','observing')").run(JSON.stringify(data),now,agent,change.id);this.journal.audit(agent,'persona-development-invalidated',{changeId:change.id,reviewId:change.reviewId,traitKey:change.key,reason:data.statusReason,refs:change.refs});}state.version++;this.writeState(agent,state);});return true;
  }
  changeEvidenceValid(agent,change){return Array.isArray(change.evidence)&&change.evidence.length>0&&change.evidence.every(saved=>{const live=this.sourceEvidence(agent,saved.id);return !!live&&this.fingerprint(live)===saved.fingerprint;});}
  redactedChange(change){return {...change,label:'已撤回来源的偏移记录',description:'',reason:'来源已撤回、过期或修订，历史衍生文本已移除。',redacted:true};}
  safeChange(agent,change){return change.redacted||!this.changeEvidenceValid(agent,change)?this.redactedChange(change):change;}
  traits(changes){
    const groups=new Map();
    for(const change of changes){if(change.status!=='active')continue;const slot=change.kind+':'+change.key,current=groups.get(slot)??{kind:change.kind,key:change.key,strength:0,changeIds:[],refs:[],ownerPreference:false};
      // Replay desired targets rather than additive deltas. Removing an older
      // increase cannot turn a later reduction into an unrelated negative trait.
      current.strength=round(clamp(current.strength+Math.max(-.1,Math.min(.1,change.strength-current.strength))));
      Object.assign(current,{label:change.label,description:change.description,confidence:change.confidence,lastChangedAt:change.created});current.changeIds.push(change.id);for(const ref of change.refs)if(!current.refs.includes(ref))current.refs.push(ref);groups.set(slot,current);
    }
    return [...groups.values()].filter(row=>Math.abs(row.strength)>.000001).sort((a,b)=>Math.abs(b.strength)-Math.abs(a.strength)||b.lastChangedAt-a.lastChangedAt||a.key.localeCompare(b.key));
  }
  snapshot(agent){this.reconcile(agent);const settings=this.settings(agent),changes=this.changes(agent),history=[...changes].reverse().slice(0,64).map(row=>this.safeChange(agent,row));return {version:settings.version,settings,currentTraits:this.traits(changes).slice(0,24),history,pending:[...changes].reverse().filter(row=>row.status==='observing').slice(0,24).map(row=>this.safeChange(agent,row)),policy:personaDevelopmentPolicy};}
  export(agent){this.reconcile(agent);const settings=this.settings(agent),changes=this.changes(agent),history=[...changes].reverse().map(row=>this.safeChange(agent,row)),reviews=this.db.prepare('SELECT id,base_version,result_version,data,created FROM human_persona_development_review WHERE agent=? ORDER BY created,id').all(agent).map(row=>({id:row.id,baseVersion:row.base_version,resultVersion:row.result_version,created:row.created,...parse(row.data)}));return {version:settings.version,settings,currentTraits:this.traits(changes),history,pending:history.filter(row=>row.status==='observing'),reviews,policy:personaDevelopmentPolicy};}
  context(agent){const snapshot=this.snapshot(agent);return snapshot.settings.enabled?snapshot.currentTraits.slice(0,8).map(row=>({kind:row.kind,key:row.key,label:row.label,description:row.description.slice(0,240),strength:row.strength,confidence:row.confidence,refs:row.refs.slice(0,6),inference:true,subject:'agent',scope:'emergent-agent-tendency',authoritative:false,ownerPreference:false})):[];}
  due(agent){this.reconcile(agent);const state=this.settings(agent);return state.enabled&&(state.lastReviewedAt===null||this.now(agent)-state.lastReviewedAt>=DAY);}
  checkedItem(item){
    if(!plain(item)||Object.keys(item).some(key=>!['kind','key','label','description','strength','confidence','refs','reason'].includes(key))||!personaDevelopmentPolicy.kinds.includes(item.kind)||typeof item.key!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/u.test(item.key)||!Number.isFinite(item.strength)||item.strength< -1||item.strength>1||!Number.isFinite(item.confidence)||item.confidence<0||item.confidence>1||!Array.isArray(item.refs)||item.refs.length<1||item.refs.length>12||new Set(item.refs).size!==item.refs.length||item.refs.some(id=>!ident(id)))fail('INVALID_PERSONA_DEVELOPMENT');
    const checked={kind:item.kind,key:item.key,label:text(item.label,80),description:text(item.description,400),strength:round(clamp(item.strength)),confidence:item.confidence,refs:[...item.refs],reason:text(item.reason,500)};
    if(boundaryRisk([checked.key,checked.label,checked.description].join(' ')))fail('PERSONA_CORE_CHANGE_REFUSED');return checked;
  }
  applyReview(agent,{items,reviewId,baseVersion}={}){
    this.admitted(agent);if(!ident(reviewId)||!Number.isSafeInteger(baseVersion)||!Array.isArray(items)||items.length>3)fail('INVALID_PERSONA_REVIEW');
    const checked=items.map(item=>this.checkedItem(item));if(new Set(checked.map(row=>row.kind+':'+row.key)).size!==checked.length)fail('INVALID_PERSONA_REVIEW');const requestHash=hash({items:checked});
    const old=this.db.prepare('SELECT * FROM human_persona_development_review WHERE agent=? AND id=?').get(agent,reviewId);if(old){if(old.request_hash!==requestHash)fail('PERSONA_REVIEW_CONFLICT');return {...this.snapshot(agent),review:{id:reviewId,...parse(old.data),idempotent:true}};}
    return this.journal.transaction(()=>{
      this.reconcile(agent);const state=this.rawSettings(agent),now=this.now(agent);if(state.version!==baseVersion)fail('STALE_PERSONA_DEVELOPMENT');if(!state.enabled)fail('PERSONA_DEVELOPMENT_DISABLED');if(state.last_reviewed!==null&&now-state.last_reviewed<DAY)fail('PERSONA_REVIEW_COOLDOWN');
      const previous=this.changes(agent),current=this.traits(previous),slots=new Set(current.map(row=>row.kind+':'+row.key)),decisions=[];
      for(const item of checked){
        const evidence=item.refs.map(id=>this.sourceEvidence(agent,id));if(evidence.some(row=>!row))fail('INVALID_PERSONA_EVIDENCE');
        const roots=[...new Set(evidence.map(row=>row.root))],span=Math.max(...evidence.map(row=>row.occurred))-Math.min(...evidence.map(row=>row.occurred)),prior=current.find(row=>row.kind===item.kind&&row.key===item.key),before=prior?.strength??0,after=round(clamp(before+Math.max(-.1,Math.min(.1,item.strength-before))));
        const used=new Set(previous.filter(row=>row.kind===item.kind&&row.key===item.key&&row.wasApplied).flatMap(row=>row.evidence?.map(v=>v.root)??[])),freshRoots=roots.filter(root=>!used.has(root));
        let statusReason=roots.length<3?'independent-evidence-needed':span<DAY?'longer-observation-needed':item.confidence<.7?'confidence-below-threshold':freshRoots.length<3?'new-independent-evidence-needed':Math.abs(after-before)<.000001?'no-material-change':!slots.has(item.kind+':'+item.key)&&slots.size>=24?'trait-capacity-reached':null;
        const status=statusReason?'observing':'active';if(status==='active')slots.add(item.kind+':'+item.key);
        decisions.push({...item,id:randomUUID(),reviewId,status,statusReason,created:now,updated:now,before,after:status==='active'?after:before,wasApplied:status==='active',evidence:evidence.map(row=>{const {excerpt,...saved}=row;return {...saved,fingerprint:this.fingerprint(row)};}),independentRoots:roots.length,evidenceSpanMs:span,subject:'agent',ownerPreference:false,stableCoreChanged:false,permissionsChanged:false,revertedAt:null});
      }
      for(const change of decisions)this.db.prepare('INSERT INTO human_persona_development_change VALUES(?,?,?,?,?,?,?,?,?)').run(change.id,agent,reviewId,change.kind,change.key,change.status,JSON.stringify(change),now,now);
      state.version++;state.last_reviewed=now;if(decisions.some(row=>row.status==='active'))state.last_applied=now;this.writeState(agent,state);const review={applied:decisions.filter(row=>row.status==='active').length,observing:decisions.filter(row=>row.status==='observing').length,changeIds:decisions.map(row=>row.id),at:now};
      this.db.prepare('INSERT INTO human_persona_development_review VALUES(?,?,?,?,?,?,?)').run(agent,reviewId,requestHash,baseVersion,state.version,JSON.stringify(review),now);
      this.journal.audit(agent,'persona-development-reviewed',{reviewId,version:state.version,...review,stableCoreChanged:false,permissionsChanged:false});for(const change of decisions)this.journal.audit(agent,'persona-development-'+(change.status==='active'?'applied':'observing'),{changeId:change.id,reviewId,kind:change.kind,key:change.key,reasonHash:hash(change.reason),before:change.before,after:change.after,refs:change.refs,independentRoots:change.independentRoots,evidenceSpanMs:change.evidenceSpanMs});return {...this.snapshot(agent),review:{id:reviewId,...review,idempotent:false}};
    });
  }
  revert(agent,changeId,expectedVersion){
    this.admitted(agent);if(!ident(changeId)||!Number.isSafeInteger(expectedVersion))fail('INVALID_PERSONA_REVERT');
    return this.journal.transaction(()=>{this.reconcile(agent);const state=this.rawSettings(agent);if(state.version!==expectedVersion)fail('STALE_PERSONA_DEVELOPMENT');const change=this.changes(agent).find(row=>row.id===changeId);if(!change)fail('PERSONA_CHANGE_NOT_FOUND');if(change.status==='reverted')return this.snapshot(agent);const now=this.now(agent),data={...change,revertedAt:now,statusReason:'owner-reverted-single-change'};this.db.prepare("UPDATE human_persona_development_change SET status='reverted',data=?,updated=? WHERE agent=? AND id=?").run(JSON.stringify(data),now,agent,changeId);state.version++;this.writeState(agent,state);this.journal.audit(agent,'persona-development-reverted',{changeId,reviewId:change.reviewId,kind:change.kind,key:change.key,version:state.version,reason:'owner-reverted-single-change',otherChangesPreserved:true});return this.snapshot(agent);});
  }
  purge(agent){for(const table of ['human_persona_development_change','human_persona_development_review','human_persona_development_state'])this.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(agent);}
}
