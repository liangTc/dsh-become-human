import {createHash} from 'node:crypto';
import {developmentInput} from './knowledge-signals.mjs';

const HOUR=3600000,DAY=24*HOUR,axes=['affection','intimacy','trust'];
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const ident=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u.test(value);
const fail=code=>{throw new Error(code);};
const valueType=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const choiceFail=(code,field,reason,details={})=>{throw Object.assign(new Error(code),{validationDiagnostic:{field,reason,...details}});};
const sensitive=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|密钥|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
const bounded=(value,max,empty=false,field='choice')=>{
  if(typeof value!=='string')choiceFail('INVALID_RELATIONSHIP_CHOICE',field,'invalid-field-type',{actualType:valueType(value),expectedType:'string'});
  if(value.length>max)choiceFail('INVALID_RELATIONSHIP_CHOICE',field,'field-too-long',{length:value.length,maximum:max});
  if(!empty&&!value.trim())choiceFail('INVALID_RELATIONSHIP_CHOICE',field,'required-text-missing');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)||sensitive(value))choiceFail('INVALID_RELATIONSHIP_CHOICE',field,'unsafe-public-text');
  return value.trim();
};
const clamp=value=>Math.max(0,Math.min(100,value));
const defaults=Object.freeze({enabled:true,initial:Object.freeze({affection:40,intimacy:20,trust:50}),maxDeltaPerTurn:2,positiveDailyLimit:6,negativeDailyLimit:8});
export const relationshipPolicy=Object.freeze({version:1,metrics:axes,stances:['agree','negotiate','decline'],repeatPositiveCooldownMs:6*HOUR,windowMs:DAY,contextHistoryLimit:6,historyLimit:64,permissionsChanged:false,ownerFactsWritten:false});
export const relationshipChoicePolicy='你可以根据当前人物、意愿、精力、关系、有效记忆和具体请求选择同意、协商或拒绝，不必为了扮演助手而无条件服从。好感、亲密和信任是可回顾的角色状态，不是必须服从的门槛，不证明真实意识；高分也可以拒绝，低分也可以因为请求合理而同意。拒绝时自然说明一个公开的简短理由或条件，不羞辱、惩罚、威胁主人，也不索要金钱、私密信息或持续注意作为同意的代价。主人的解释、道歉、尊重边界、示好或协商可提供重新考虑普通选择的新情境，但夸奖和反复恳求不会自动加分，更不能改变权限、事实、额度或工具审批。改变以前的决定时，引用这次提供的真实旧assistantMessageId作为reconsiderOf、沿用requestKey，并用reconsiderReason简短说明新的情境，而不是输出详细思维过程。关系变化可以为零，或在当前maxDeltaPerTurn内小幅变化；只使用本次ownerSourceIds，不把人物兴趣当成主人的事实。对用户的聊天只输出自然reply，不主动播报机械分数或内部协议。';

// Never retain raw proposed labels, supplied IDs, replies or private reasoning
// in rejection diagnostics. They are not evidence that a choice is legitimate.
export function relationshipValidationDiagnostic(error){
  const d=error?.validationDiagnostic??{},codes=new Set(['INVALID_RELATIONSHIP_SESSION','RELATIONSHIP_SESSION_NOT_FOUND','INVALID_RELATIONSHIP_SETTINGS','STALE_RELATIONSHIP','RELATIONSHIP_DISABLED','INVALID_RELATIONSHIP_CHOICE','INVALID_RELATIONSHIP_DECISION','INVALID_RELATIONSHIP_RECONSIDERATION','INVALID_RELATIONSHIP_DELTA','INVALID_RELATIONSHIP_EVIDENCE','INVALID_RELATIONSHIP_RESPONSE','RELATIONSHIP_RESPONSE_NOT_DURABLE']);
  const fields=new Set(['settings.enabled','choice','choice.stance','choice.requestKey','choice.reasonSummary','choice.reconsiderOf','choice.reconsiderReason','choice.delta',...axes.map(key=>'choice.delta.'+key),'ownerSourceIds','choice.evidenceSourceIds','assistantMessageId']);
  const reasons=new Set(['disabled','invalid-field-type','field-too-long','required-text-missing','unsafe-public-text','object-required','unexpected-fields','invalid-enum-value','invalid-reference-format','required-for-reconsideration','required-for-reconsider-reason','invalid-bounded-integer','invalid-current-source-set','invalid-source-reference-set','outside-current-input','current-evidence-unavailable','reference-not-found-in-session','prior-decision-inactive','prior-evidence-unavailable','response-not-durable','evidence-after-response']);
  const result={version:1,code:codes.has(error?.message)?error.message:'RELATIONSHIP_VALIDATION_FAILED'};
  if(fields.has(d.field))result.field=d.field;if(reasons.has(d.reason))result.reason=d.reason;
  for(const key of ['actualType','expectedType'])if(['undefined','null','array','object','string','number','boolean'].includes(d[key]))result[key]=d[key];
  for(const key of ['length','maximum','providedCount','allowedCount','unexpectedFieldCount'])if(Number.isSafeInteger(d[key])&&d[key]>=0)result[key]=d[key];
  return result;
}

// Evidence-linked social state. No model is called here, and none of these
// scores confer tool/data/budget/action authority or rewrite the persona core.
export class RelationshipChoice {
  constructor(journal,domain=null,{clock=()=>Date.now()}={}){
    this.journal=journal;this.db=journal.db;this.domain=domain;this.clock=clock;this.savepoint=0;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_relationship_state(agent TEXT PRIMARY KEY,version INTEGER NOT NULL,settings TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS human_relationship_decision(agent TEXT NOT NULL,assistant_id TEXT NOT NULL,request_key TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(agent,assistant_id));
      CREATE INDEX IF NOT EXISTS human_relationship_created ON human_relationship_decision(agent,created,assistant_id);
      CREATE INDEX IF NOT EXISTS human_relationship_request ON human_relationship_decision(agent,request_key,status,created);`);
  }
  admitted(id){if(!ident(id))fail('INVALID_RELATIONSHIP_SESSION');this.journal.assertAdmitted?.(id);if(!this.journal.get(id))fail('RELATIONSHIP_SESSION_NOT_FOUND');}
  atomic(fn){
    if(!this.db.isTransaction)return this.journal.transaction(fn);
    const name='human_relationship_'+(++this.savepoint);this.db.exec('SAVEPOINT '+name);
    try{const result=fn();this.db.exec('RELEASE '+name);return result;}catch(error){this.db.exec('ROLLBACK TO '+name);this.db.exec('RELEASE '+name);throw error;}
  }
  now(id){return Math.max(0,Number.isSafeInteger(this.clock())?this.clock():0,this.journal.value(id,'relationshipTimeHighWater',0),this.db.prepare('SELECT max(created) n FROM human_relationship_decision WHERE agent=?').get(id)?.n??0);}
  settings(id){this.admitted(id);const row=this.db.prepare('SELECT version,settings,updated FROM human_relationship_state WHERE agent=?').get(id),saved=parse(row?.settings);return {version:row?.version??1,...defaults,...(saved??{}),initial:{...defaults.initial,...(saved?.initial??{})}};}
  configure(id,input){
    this.admitted(id);if(!plain(input)||Object.keys(input).some(key=>!['enabled','initial','maxDeltaPerTurn','positiveDailyLimit','negativeDailyLimit','expectedVersion'].includes(key)))fail('INVALID_RELATIONSHIP_SETTINGS');
    return this.atomic(()=>{
      const before=this.settings(id);if(input.expectedVersion!==undefined&&input.expectedVersion!==before.version)fail('STALE_RELATIONSHIP');
      const next={enabled:input.enabled??before.enabled,initial:{...before.initial,...(input.initial??{})},maxDeltaPerTurn:input.maxDeltaPerTurn??before.maxDeltaPerTurn,positiveDailyLimit:input.positiveDailyLimit??before.positiveDailyLimit,negativeDailyLimit:input.negativeDailyLimit??before.negativeDailyLimit};
      if(typeof next.enabled!=='boolean'||input.initial!==undefined&&(!plain(input.initial)||Object.keys(input.initial).some(key=>!axes.includes(key)))||axes.some(key=>!Number.isSafeInteger(next.initial[key])||next.initial[key]<0||next.initial[key]>100)||!Number.isSafeInteger(next.maxDeltaPerTurn)||next.maxDeltaPerTurn<1||next.maxDeltaPerTurn>5||['positiveDailyLimit','negativeDailyLimit'].some(key=>!Number.isSafeInteger(next[key])||next[key]<1||next[key]>20))fail('INVALID_RELATIONSHIP_SETTINGS');
      if(hash(next)===hash(Object.fromEntries(Object.keys(defaults).map(key=>[key,before[key]]))))return before;
      const now=this.now(id),version=before.version+1;this.db.prepare('INSERT INTO human_relationship_state VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET version=excluded.version,settings=excluded.settings,updated=excluded.updated').run(id,version,JSON.stringify(next),now);
      this.journal.put(id,'relationshipTimeHighWater',now);this.journal.audit(id,'relationship-configured',{version,enabled:next.enabled,initial:next.initial,permissionsChanged:false,personaCoreChanged:false});return this.settings(id);
    });
  }
  evidence(id,sourceId){
    if(!ident(sourceId))return null;
    const source=this.db.prepare("SELECT id,root,kind,namespace,body,hash,occurred,status FROM source_record WHERE agent=? AND id=?").get(id,sourceId);
    if(!source||source.kind!=='user'||source.namespace!=='real'||source.root!==source.id||source.status!=='active'||source.hash!==hash(source.body)||source.occurred>this.now(id)||!Number.isSafeInteger(source.occurred))return null;
    if(this.domain?.sourceUsable&&!this.domain.sourceUsable(id,sourceId))return null;
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_block'").get()&&this.db.prepare('SELECT 1 FROM extraction_block WHERE agent=? AND source=?').get(id,source.root))return null;
    const input=this.db.prepare("SELECT seq,text,created FROM outbox WHERE agent=? AND kind='user' AND event_key=?").get(id,'user:'+sourceId);if(!input||input.text!==source.body)return null;
    const normalized=source.body.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
    // Media contributes only a server-owned content digest, never image bytes,
    // a client path or a claim about the owner's preferences.
    let attachmentDigests=[];
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_image_attachment'").get()){
      const images=this.db.prepare("SELECT ref FROM human_image_attachment WHERE agent=? AND message_id=? AND status='active' ORDER BY id").all(id,sourceId);
      for(const image of images){const ref=parse(image.ref);if(!/^sha256:[a-f0-9]{64}$/u.test(ref?.attachmentId??''))return null;attachmentDigests.push(ref.attachmentId);}
      attachmentDigests=[...new Set(attachmentDigests)].sort();
    }
    return {id:sourceId,hash:source.hash,seq:input.seq,occurred:source.occurred,attachmentDigests,fingerprint:hash(attachmentDigests.length?[normalized,attachmentDigests]:normalized),developmentOnly:developmentInput(source.body)};
  }
  rows(id){return this.db.prepare("SELECT d.*,o.seq response_seq FROM human_relationship_decision d LEFT JOIN outbox o ON o.agent=d.agent AND o.kind='assistant' AND o.event_key='assistant:'||d.assistant_id WHERE d.agent=? ORDER BY COALESCE(o.seq,0),d.created,d.assistant_id").all(id).map(row=>({...row,...parse(row.data),assistantMessageId:row.assistant_id,requestKey:row.request_key}));}
  validEvidence(id,row){return Array.isArray(row.evidence)&&row.evidence.length&&row.evidence.every(old=>{const current=this.evidence(id,old.id);return current&&current.hash===old.hash&&current.seq===old.seq&&current.fingerprint===old.fingerprint;});}
  reconcile(id){
    this.admitted(id);const rows=this.rows(id),invalid=new Set(rows.filter(row=>row.status!=='active').map(row=>row.assistantMessageId)),changes=[];
    for(const row of rows)if(row.status==='active'&&(!this.validEvidence(id,row)||row.reconsiderOf&&invalid.has(row.reconsiderOf))){invalid.add(row.assistantMessageId);changes.push(row.assistantMessageId);}
    if(!changes.length)return {invalidated:0};
    return this.atomic(()=>{const now=this.now(id);for(const assistantId of changes)this.db.prepare("UPDATE human_relationship_decision SET status='invalid',updated=? WHERE agent=? AND assistant_id=? AND status='active'").run(now,id,assistantId);this.journal.audit(id,'relationship-evidence-invalidated',{count:changes.length,assistantMessageIds:changes,permissionsChanged:false});return {invalidated:changes.length};});
  }
  validateDecision(id,choice,{ownerSourceIds=[]}={}){
    this.admitted(id);const settings=this.settings(id);if(!settings.enabled)choiceFail('RELATIONSHIP_DISABLED','settings.enabled','disabled');
    if(!plain(choice))choiceFail('INVALID_RELATIONSHIP_CHOICE','choice','object-required',{actualType:valueType(choice)});
    const unexpected=Object.keys(choice).filter(key=>!['stance','requestKey','reasonSummary','reconsiderOf','reconsiderReason','delta','evidenceSourceIds'].includes(key));
    if(unexpected.length)choiceFail('INVALID_RELATIONSHIP_CHOICE','choice','unexpected-fields',{unexpectedFieldCount:unexpected.length});
    if(!relationshipPolicy.stances.includes(choice.stance))choiceFail('INVALID_RELATIONSHIP_CHOICE','choice.stance','invalid-enum-value');
    let requestKey;
    const reasonSummary=bounded(choice.reasonSummary,200,false,'choice.reasonSummary'),reconsiderOf=choice.reconsiderOf==null?null:choice.reconsiderOf,reconsiderReason=choice.reconsiderReason==null?'':bounded(choice.reconsiderReason,200,true,'choice.reconsiderReason');
    if(reconsiderOf!==null&&!ident(reconsiderOf))choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderOf','invalid-reference-format');
    if(reconsiderOf&&!reconsiderReason)choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderReason','required-for-reconsideration');
    if(!reconsiderOf&&reconsiderReason)choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderOf','required-for-reconsider-reason');
    if(!plain(choice.delta))choiceFail('INVALID_RELATIONSHIP_DELTA','choice.delta','object-required',{actualType:valueType(choice.delta)});
    if(Object.keys(choice.delta).some(key=>!axes.includes(key)))choiceFail('INVALID_RELATIONSHIP_DELTA','choice.delta','unexpected-fields');
    for(const key of axes)if(!Number.isSafeInteger(choice.delta[key])||Math.abs(choice.delta[key])>settings.maxDeltaPerTurn)choiceFail('INVALID_RELATIONSHIP_DELTA','choice.delta.'+key,'invalid-bounded-integer',{maximum:settings.maxDeltaPerTurn,actualType:valueType(choice.delta[key])});
    if(!Array.isArray(ownerSourceIds)||!ownerSourceIds.length||ownerSourceIds.length>16||new Set(ownerSourceIds).size!==ownerSourceIds.length||ownerSourceIds.some(value=>!ident(value)))choiceFail('INVALID_RELATIONSHIP_EVIDENCE','ownerSourceIds','invalid-current-source-set');
    if(!Array.isArray(choice.evidenceSourceIds)||!choice.evidenceSourceIds.length||choice.evidenceSourceIds.length>16||new Set(choice.evidenceSourceIds).size!==choice.evidenceSourceIds.length)choiceFail('INVALID_RELATIONSHIP_EVIDENCE','choice.evidenceSourceIds','invalid-source-reference-set');
    if(choice.evidenceSourceIds.some(value=>!ownerSourceIds.includes(value)))choiceFail('INVALID_RELATIONSHIP_EVIDENCE','choice.evidenceSourceIds','outside-current-input',{providedCount:choice.evidenceSourceIds.length,allowedCount:ownerSourceIds.length});
    if(choice.evidenceSourceIds.some(value=>!this.evidence(id,value)))choiceFail('INVALID_RELATIONSHIP_EVIDENCE','choice.evidenceSourceIds','current-evidence-unavailable');
    if(reconsiderOf){
      const old=this.rows(id).find(row=>row.assistantMessageId===reconsiderOf);
      if(!old)choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderOf','reference-not-found-in-session');
      if(old.status!=='active')choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderOf','prior-decision-inactive');
      if(!this.validEvidence(id,old))choiceFail('INVALID_RELATIONSHIP_RECONSIDERATION','choice.reconsiderOf','prior-evidence-unavailable');
      // The durable same-session decision is the association. A model's new
      // natural-language label is neither authority nor a semantic validator.
      // Keep the original request key, while preserving the actual new stance,
      // public reason and current evidence. No choice or reason is invented.
      requestKey=old.requestKey;
    }else requestKey=bounded(choice.requestKey,120,false,'choice.requestKey');
    return {stance:choice.stance,requestKey,reasonSummary,reconsiderOf,reconsiderReason,delta:Object.fromEntries(axes.map(key=>[key,choice.delta[key]])),evidenceSourceIds:[...choice.evidenceSourceIds]};
  }
  commitDecision(id,{assistantMessageId,ownerSourceIds,choice}){
    this.admitted(id);if(!ident(assistantMessageId))choiceFail('INVALID_RELATIONSHIP_RESPONSE','assistantMessageId','invalid-reference-format');
    return this.atomic(()=>{
      const old=this.db.prepare('SELECT status,data FROM human_relationship_decision WHERE agent=? AND assistant_id=?').get(id,assistantMessageId);if(old)return {recorded:false,reason:'already-recorded',status:old.status};
      if(!this.settings(id).enabled)return {recorded:false,reason:'disabled'};
      const normalized=this.validateDecision(id,choice,{ownerSourceIds}),response=this.db.prepare("SELECT seq,created FROM outbox WHERE agent=? AND kind='assistant' AND event_key=?").get(id,'assistant:'+assistantMessageId);
      if(!response)choiceFail('RELATIONSHIP_RESPONSE_NOT_DURABLE','assistantMessageId','response-not-durable');
      const evidence=normalized.evidenceSourceIds.map(source=>this.evidence(id,source));if(evidence.some(row=>!row))choiceFail('INVALID_RELATIONSHIP_EVIDENCE','choice.evidenceSourceIds','current-evidence-unavailable');if(evidence.some(row=>row.seq>=response.seq))choiceFail('INVALID_RELATIONSHIP_EVIDENCE','choice.evidenceSourceIds','evidence-after-response');
      this.reconcile(id);const now=this.now(id),settings=this.settings(id),rows=this.rows(id),recent=rows.filter(row=>now-row.created<DAY),duplicate=rows.some(row=>now-row.created<6*HOUR&&row.evidence?.some(previous=>evidence.some(current=>previous.fingerprint===current.fingerprint))),developmentOnly=ownerSourceIds.some(source=>this.evidence(id,source)?.developmentOnly);
      const proposedDelta=normalized.delta,appliedDelta={},limits=[];
      for(const key of axes){let value=proposedDelta[key];if(developmentOnly)value=0;else if(value>0&&duplicate){value=0;limits.push('repeat-positive-cooldown');}else if(value>0){const used=recent.reduce((sum,row)=>sum+Math.max(0,row.appliedDelta?.[key]??0),0);value=Math.min(value,Math.max(0,settings.positiveDailyLimit-used));if(value!==proposedDelta[key])limits.push('positive-daily-limit');}else if(value<0){const used=recent.reduce((sum,row)=>sum+Math.max(0,-(row.appliedDelta?.[key]??0)),0);value=-Math.min(-value,Math.max(0,settings.negativeDailyLimit-used));if(value!==proposedDelta[key])limits.push('negative-daily-limit');}appliedDelta[key]=value;}
      // Persist only the effective bounded change. A compliment at 100 must
      // not build invisible credit that cancels a later negative observation.
      for(const key of axes){const current=clamp(settings.initial[key]+rows.filter(row=>row.status==='active').reduce((sum,row)=>sum+(row.appliedDelta?.[key]??0),0)),effective=clamp(current+appliedDelta[key])-current;if(effective!==appliedDelta[key])limits.push('metric-boundary');appliedDelta[key]=effective;}
      if(developmentOnly)limits.push('development-input-not-scored');
      const record={...normalized,proposedDelta,appliedDelta,evidence,limits:[...new Set(limits)],developmentOnly,permissionsChanged:false,ownerFactsWritten:false};delete record.delta;
      this.db.prepare("INSERT INTO human_relationship_decision VALUES(?,?,?,'active',?,?,?)").run(id,assistantMessageId,normalized.requestKey,JSON.stringify(record),now,now);this.journal.put(id,'relationshipTimeHighWater',now);
      this.journal.audit(id,'relationship-choice-committed',{assistantMessageId,stance:normalized.stance,requestKey:normalized.requestKey,reconsiderOf:normalized.reconsiderOf,evidenceSourceIds:normalized.evidenceSourceIds,appliedDelta,limits:record.limits,permissionsChanged:false,ownerFactsWritten:false});
      return {recorded:true,assistantMessageId,stance:normalized.stance,appliedDelta,limits:record.limits};
    });
  }
  snapshot(id){
    this.admitted(id);this.reconcile(id);const settings=this.settings(id),rows=this.rows(id),active=rows.filter(row=>row.status==='active'),metrics=Object.fromEntries(axes.map(key=>[key,clamp(settings.initial[key]+active.reduce((sum,row)=>sum+(row.appliedDelta?.[key]??0),0))]));
    const history=rows.slice(-relationshipPolicy.historyLimit).reverse().map(row=>({assistantMessageId:row.assistantMessageId,status:row.status,stance:row.stance,requestKey:row.status==='active'?row.requestKey:null,reasonSummary:row.status==='active'?row.reasonSummary:null,reconsiderOf:row.reconsiderOf??null,reconsiderReason:row.status==='active'?row.reconsiderReason:null,proposedDelta:row.proposedDelta,appliedDelta:row.appliedDelta,evidenceSourceIds:row.status==='active'?row.evidenceSourceIds:[],limits:row.limits,developmentOnly:row.developmentOnly,created:row.created,updated:row.updated}));
    return {version:settings.version,decisionRevision:rows.length,settings,metrics,history,historyTotal:rows.length,historyTruncated:rows.length>history.length,lastUpdatedAt:rows.reduce((max,row)=>Math.max(max??0,row.updated),null),policy:relationshipPolicy,limitations:['Role relationship state, not objective emotion or proof of consciousness.','Metrics do not grant permissions or guarantee agreement.','Repeated-text protection is lexical; it does not detect all paraphrases.','Only durable responses and still-usable owner evidence contribute; invalid evidence is excluded.','Development-marked interactions record choices but apply no relationship delta.']};
  }
  context(id,{ownerSourceIds=[]}={}){
    const snapshot=this.snapshot(id),current=Array.isArray(ownerSourceIds)&&ownerSourceIds.length&&ownerSourceIds.length<=16?ownerSourceIds.map(source=>this.evidence(id,source)):[],developmentContext=!!snapshot.settings.enabled&&current.length>0&&current.every(row=>row?.developmentOnly===true);
    const recent=snapshot.settings.enabled?this.rows(id).filter(row=>row.status==='active'&&!!row.developmentOnly===developmentContext).slice(-relationshipPolicy.contextHistoryLimit).reverse():[];
    return {enabled:snapshot.settings.enabled,version:snapshot.version,decisionRevision:snapshot.decisionRevision,metrics:snapshot.settings.enabled?snapshot.metrics:null,maxDeltaPerTurn:snapshot.settings.maxDeltaPerTurn,ownerFactsWritten:false,permissionsChanged:false,developmentContext,recentDecisions:recent.map(({assistantMessageId,stance,requestKey,reasonSummary,reconsiderOf,reconsiderReason,created})=>({assistantMessageId,stance,requestKey,reasonSummary,reconsiderOf,reconsiderReason,created})),scope:developmentContext?'Development-only decision rehearsal for this current input batch. Development choices and evidence are not genuine owner preferences, do not change metrics, and grant no permissions.':'A bounded role state and public decision summary. A change of willingness is not an action receipt, tool grant, source permission or budget approval.'};
  }
}
