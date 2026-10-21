import {createHash,randomUUID} from 'node:crypto';
import {fetchResearch,researchUrl} from './learning.mjs';
import {assertCapabilitySchema,validateCapabilityInput,plain} from './capability-schema.mjs';
import {capabilityDefaults,validateCapabilitySettings} from './capability-policy.mjs';
const parse=value=>value?JSON.parse(value):null;
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=code=>{throw new Error(code);};
const codeOf=e=>/^[A-Z_]{3,80}$/.test(e?.code??e?.message??'')?(e.code??e.message):'CAPABILITY_EXECUTION_FAILED';
const at=(value,path)=>path.split('.').reduce((current,key)=>current?.[key],value);
const urlSchema={type:'object',additionalProperties:false,properties:{url:{type:'string',format:'uri',description:'明确指定的公开网页地址',minLength:1,maxLength:2048}},required:['url']};
function boundedReadResult(result,limit){
  const encoded=JSON.stringify(result??null);if(Buffer.byteLength(encoded)<=limit)return result;
  const wrap=length=>({truncated:true,format:'json-excerpt',originalBytes:Buffer.byteLength(encoded),text:encoded.slice(0,length),evidenceStatus:'read-not-verified',meaning:'Partial serialized tool output; not the full result or a verified conclusion.'});
  let low=0,high=encoded.length;while(low<high){const mid=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(wrap(mid)))<=limit)low=mid;else high=mid-1;}return wrap(low);
}

// Registered adapters share the durable queue and the parent's serial interval.
export class ToolExecutor {
  constructor(journal){
    this.journal=journal;this.db=journal.db;this.registry=new Map();this.inflight=new Set();this.executions=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_tool_job(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,tool TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL,result TEXT,error TEXT,UNIQUE(agent,request_id));
      CREATE INDEX IF NOT EXISTS human_tool_pending ON human_tool_job(agent,status,created);
      CREATE TABLE IF NOT EXISTS human_page_snapshot(agent TEXT NOT NULL,url TEXT NOT NULL,digest TEXT NOT NULL,fetched INTEGER NOT NULL,job TEXT NOT NULL,PRIMARY KEY(agent,url));
      CREATE TABLE IF NOT EXISTS human_capability_job(agent TEXT NOT NULL,id TEXT PRIMARY KEY,snapshot TEXT NOT NULL,origin TEXT NOT NULL,task_id TEXT,policy_revision INTEGER NOT NULL,prepared TEXT,digest TEXT NOT NULL,approval_key TEXT,approval_expires INTEGER);`);
    for(const name of ['read-public-page','compare-public-page'])this.register(name,{description:name==='read-public-page'?'读取公开网页正文与来源，不生成未经核验的知识':'与上次成功读取的公开正文指纹比较',inputSchema:urlSchema,effect:'read',backend:'public-read',scope:'public-web',retrySafe:true,autonomous:true,validate:input=>({url:researchUrl(input.url)}),execute:(input,signal,context)=>this.readPage(context.agent,input,signal,name==='compare-public-page')});
  }
  register(name,adapter){
    if(!/^[a-zA-Z][a-zA-Z0-9_.-]{2,127}$/.test(name)||this.registry.has(name)||typeof adapter?.execute!=='function'||typeof adapter.description!=='string'||!['read','write'].includes(adapter.effect))fail('INVALID_TOOL_ADAPTER');
    assertCapabilitySchema(adapter.inputSchema);
    if(adapter.outputSchema)assertCapabilitySchema(adapter.outputSchema);
    const definition={id:name,title:adapter.title??name,description:adapter.description,version:adapter.version??1,inputSchema:structuredClone(adapter.inputSchema),effect:adapter.effect,sideEffects:adapter.effect==='write',backend:adapter.backend??'local',scope:typeof adapter.scope==='function'?(adapter.scopeDescription??'specific-target'):adapter.scope??'explicit-input',timeoutMs:adapter.timeoutMs??60000,maxResultBytes:adapter.maxResultBytes??32768,retrySafe:adapter.effect==='read'&&adapter.retrySafe!==false,autonomous:adapter.effect==='read'&&adapter.autonomous===true,enabledWhen:adapter.enabledWhen??[],externalModel:adapter.externalModel===true,independentSession:false};
    if(!Number.isSafeInteger(definition.timeoutMs)||definition.timeoutMs<1000||definition.timeoutMs>120000||!Number.isSafeInteger(definition.maxResultBytes)||definition.maxResultBytes<1024||definition.maxResultBytes>131072||!Array.isArray(definition.enabledWhen)||definition.enabledWhen.some(path=>typeof path!=='string'||path.length>100))fail('INVALID_TOOL_ADAPTER');
    definition.outputSchema=adapter.outputSchema?structuredClone(adapter.outputSchema):null;
    this.registry.set(name,Object.freeze({...adapter,definition,definitionHash:hash(definition)}));return ()=>{this.registry.delete(name);for(const execution of this.executions.values())if(execution.tool===name)execution.controller.abort(new Error('CAPABILITY_DEFINITION_CHANGED'));};
  }
  configuration(agent){
    this.journal.assertAdmitted(agent);
    const row=this.journal.safety?.rows?.findLast(row=>row.kind==='human-capability-policy'&&parse(row.data)?.agent===agent);
    if(!row)return {revision:0,...structuredClone(capabilityDefaults)};
    const data=parse(row.data);return {revision:data.revision,...validateCapabilitySettings(data.settings)};
  }
  async configure(agent,settings,expectedRevision){
    const current=this.configuration(agent);if(expectedRevision!==current.revision)fail('STALE_CAPABILITY_SETTINGS');
    const next=validateCapabilitySettings(settings);if(!this.journal.safety)fail('SIGNED_CONTROL_REQUIRED');
    await this.journal.safety.prepare('capability-policy:'+randomUUID(),'human-capability-policy',{agent,revision:current.revision+1,settings:next});
    this.journal.put(agent,'humanCapabilitySettings',next);this.journal.audit(agent,'capability-configured',{revision:current.revision+1});return this.configuration(agent);
  }
  enabled(adapter,agent){const settings=this.configuration(agent);return adapter.definition.enabledWhen.every(path=>at(settings,path)===true)&&adapter.available?.()!==false;}
  catalog(agent,{origin='owner'}={}){return [...this.registry.values()].filter(a=>origin!=='autonomous'||a.definition.autonomous).map(a=>{const available=agent?this.enabled(a,agent):true;return {...a.definition,available,unavailableReason:available?null:'CAPABILITY_DISABLED'};});}
  contextCatalog(agent,origin='owner'){return this.catalog(agent,{origin}).filter(a=>a.available).map(({id,description,inputSchema,effect,scope,externalModel})=>({id,description,inputSchema,effect,scope,externalModel}));}
  metadata(id){return this.db.prepare('SELECT * FROM human_capability_job WHERE id=?').get(id);}
  checkPreview(row){const meta=this.metadata(row.id);if(meta&&meta.digest!==hash({tool:row.tool,input:row.input,snapshot:row.capabilitySnapshot,prepared:row.prepared,policyRevision:meta.policy_revision}))fail('CAPABILITY_PREVIEW_MISMATCH');}
  get(agent,id){
    this.journal.assertAdmitted(agent);const row=this.db.prepare('SELECT * FROM human_tool_job WHERE agent=? AND id=?').get(agent,id);if(!row)fail('TOOL_JOB_NOT_FOUND');
    const meta=this.metadata(id);return {...row,input:parse(row.input),result:parse(row.result),digest:meta?.digest??null,approvalExpires:meta?.approval_expires??null,capabilitySnapshot:meta?parse(meta.snapshot):this.registry.get(row.tool)?.definition,prepared:meta?parse(meta.prepared):null,origin:meta?.origin??'owner',taskId:meta?.task_id??null};
  }
  list(agent,{limit=25,offset=0}={}){this.journal.assertAdmitted(agent);if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)fail('INVALID_TOOL_QUERY');const ids=this.db.prepare('SELECT id FROM human_tool_job WHERE agent=? ORDER BY created DESC,id DESC LIMIT ? OFFSET ?').all(agent,limit,offset),total=this.db.prepare('SELECT count(*) n FROM human_tool_job WHERE agent=?').get(agent).n;return {items:ids.map(x=>this.get(agent,x.id)),total,hasMore:offset+ids.length<total};}
  submit(agent,{tool,input,requestId},{origin='owner',taskId=null}={}){
    this.journal.assertAdmitted(agent);const adapter=this.registry.get(tool);
    if(!adapter||typeof requestId!=='string'||!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestId)||!['owner','autonomous'].includes(origin))fail('INVALID_TOOL_REQUEST');
    if(!this.enabled(adapter,agent)||origin==='autonomous'&&!adapter.definition.autonomous)fail('CAPABILITY_DISABLED');
    const checked=validateCapabilityInput(adapter.definition.inputSchema,input),data=adapter.validate?adapter.validate(checked):checked;
    validateCapabilityInput(adapter.definition.inputSchema,data);if(Buffer.byteLength(JSON.stringify(data))>16384)fail('CAPABILITY_INPUT_TOO_LARGE');
    const requestHash=hash({tool,input:data}),old=this.db.prepare('SELECT id,request_hash FROM human_tool_job WHERE agent=? AND request_id=?').get(agent,requestId);
    if(old){if(old.request_hash!==requestHash)fail('REQUEST_ID_CONFLICT');return this.get(agent,old.id);}
    if(this.db.prepare("SELECT count(*) n FROM human_tool_job WHERE agent=? AND status IN ('queued','awaiting-approval','running','suspended')").get(agent).n>=16)fail('TOOL_QUEUE_FULL');
    const id=randomUUID(),now=Date.now(),policy=this.configuration(agent),context={agent,jobId:id,requestId,origin,taskId};
    return this.journal.transaction(()=>{const prepared=adapter.prepare?.(data,context)??null;if(prepared?.then||prepared!==null&&(!plain(prepared)||Buffer.byteLength(JSON.stringify(prepared))>131072))fail('INVALID_CAPABILITY_PREVIEW');
    const scope=typeof adapter.scope==='function'?adapter.scope(data):adapter.definition.scope,snapshot={...adapter.definition,definitionHash:adapter.definitionHash,scope},digest=hash({tool,input:data,snapshot,prepared,policyRevision:policy.revision});
    this.db.prepare('INSERT INTO human_tool_job VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(id,agent,requestId,requestHash,tool,JSON.stringify(data),adapter.effect==='write'?'awaiting-approval':'queued',1,now,now,now+86400000);this.db.prepare('INSERT INTO human_capability_job VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(agent,id,JSON.stringify(snapshot),origin,taskId,policy.revision,prepared?JSON.stringify(prepared):null,digest);this.journal.audit(agent,'tool-job-created',{jobId:id,tool,effect:adapter.effect,scope,digest,origin,taskId,lane:'action'});return this.get(agent,id);});
  }
  async approve(agent,id,{expectedVersion,digest}){
    const row=this.get(agent,id),meta=this.metadata(id),adapter=this.registry.get(row.tool),policy=this.configuration(agent);
    if(row.version!==expectedVersion)fail('STALE_TOOL_JOB');if(row.status!=='awaiting-approval'||!meta||!adapter||adapter.effect!=='write')fail('CAPABILITY_NOT_APPROVABLE');this.checkPreview(row);
    if(digest!==meta.digest)fail('CAPABILITY_PREVIEW_MISMATCH');if(meta.policy_revision!==policy.revision||!this.enabled(adapter,agent)||row.capabilitySnapshot.definitionHash!==adapter.definitionHash)fail('CAPABILITY_POLICY_CHANGED');
    if(row.expires<=Date.now())fail('CAPABILITY_APPROVAL_EXPIRED');if(!this.journal.safety)fail('SIGNED_CONTROL_REQUIRED');
    const key='capability-approve:'+randomUUID(),expires=Date.now()+300000;
    await this.journal.safety.prepare(key,'human-capability-approved',{agent,jobId:id,digest,definitionHash:adapter.definitionHash,policyRevision:policy.revision,expires});
    this.journal.transaction(()=>{this.db.prepare('UPDATE human_capability_job SET approval_key=?,approval_expires=? WHERE agent=? AND id=?').run(key,expires,agent,id);this.update(row,'queued');});return this.get(agent,id);
  }
  cancel(agent,id,version){const row=this.get(agent,id);if(row.version!==version)fail('STALE_TOOL_JOB');if(!['queued','awaiting-approval','suspended','failed'].includes(row.status))fail('TOOL_JOB_NOT_CANCELLABLE');this.update(row,'cancelled');return this.get(agent,id);}
  recover(agent){this.journal.assertAdmitted(agent);for(const row of this.db.prepare("SELECT id FROM human_tool_job WHERE agent=? AND status='running'").all(agent)){const job=this.get(agent,row.id);this.update(job,job.capabilitySnapshot?.effect==='write'?'unknown':'suspended',{error:job.capabilitySnapshot?.effect==='write'?'CAPABILITY_OUTCOME_UNKNOWN':'CAPABILITY_RESTARTED'});}}
  next(agent){this.journal.assertAdmitted(agent);const now=Date.now();this.db.prepare("UPDATE human_tool_job SET status='expired',version=version+1,updated=? WHERE agent=? AND status IN ('queued','suspended','awaiting-approval') AND expires<=?").run(now,agent,now);const row=this.db.prepare("SELECT id FROM human_tool_job WHERE agent=? AND status IN ('queued','suspended') ORDER BY created,id LIMIT 1").get(agent);return row?this.get(agent,row.id):null;}
  update(row,status,{result=null,error=null}={}){this.journal.assertAdmitted(row.agent);const n=this.db.prepare('UPDATE human_tool_job SET status=?,version=version+1,updated=?,result=?,error=? WHERE agent=? AND id=? AND version=?').run(status,Date.now(),result?JSON.stringify(result):null,error,row.agent,row.id,row.version);if(n.changes!==1)fail('STALE_TOOL_JOB');this.journal.audit(row.agent,'tool-job-'+status,{jobId:row.id,tool:row.tool,lane:'action',code:error});}
  async readPage(agent,input,signal,compare){
    const previous=this.db.prepare('SELECT digest,fetched,job FROM human_page_snapshot WHERE agent=? AND url=?').get(agent,input.url),source=await fetchResearch({url:input.url,title:'公开网页检查',topic:''},signal);
    const result={url:source.url,title:source.title,digest:source.digest,fetchedAt:source.fetchedAt,excerpt:source.excerpt,partial:source.partial===true,publishedAt:source.publishedAt??null,evidenceStatus:'read-not-verified',semanticVerified:false};
    if(compare)result.comparison={baselineExists:!!previous,previousJob:previous?.job??null,previousFetchedAt:previous?.fetched??null,changed:previous?result.digest!==previous.digest:null,meaning:'Extracted text fingerprint only; not a semantic conclusion.'};return result;
  }
  checkApproval(row,adapter){
    const meta=this.metadata(row.id),policy=this.configuration(row.agent);if(!meta||meta.approval_expires<=Date.now())fail('CAPABILITY_APPROVAL_EXPIRED');
    const approval=this.journal.safety?.rows?.findLast(record=>record.id===meta.approval_key&&record.kind==='human-capability-approved'),data=approval&&parse(approval.data);
    if(!data||data.agent!==row.agent||data.jobId!==row.id||data.digest!==meta.digest||data.definitionHash!==adapter.definitionHash||data.policyRevision!==policy.revision||data.expires!==meta.approval_expires)fail('CAPABILITY_APPROVAL_INVALID');
  }
  async execute(agent,id,{signal,valid}){
    let row=this.get(agent,id);if(!['queued','suspended'].includes(row.status))fail('TOOL_JOB_NOT_EXECUTABLE');valid();if(this.inflight.size)fail('CAPABILITY_BUSY');let adapter,dispatched=false;
    try{
      if(row.expires<=Date.now()){this.update(row,'expired');return this.get(agent,id);}
      adapter=this.registry.get(row.tool);if(!adapter)fail('TOOL_ADAPTER_UNAVAILABLE');if(!this.enabled(adapter,agent))fail('CAPABILITY_DISABLED');
      this.checkPreview(row);validateCapabilityInput(adapter.definition.inputSchema,row.input);
      if(row.capabilitySnapshot?.definitionHash&&row.capabilitySnapshot.definitionHash!==adapter.definitionHash)fail('CAPABILITY_DEFINITION_CHANGED');
      if(adapter.effect==='write')this.checkApproval(row,adapter);
      const policy=this.configuration(agent),controller=new AbortController(),requestSignal=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(Math.min(adapter.definition.timeoutMs,policy.limits.timeoutMs))]);
      this.executions.set(id,{tool:row.tool,controller});
      this.update(row,'running');row=this.get(agent,id);this.inflight.add(id);valid();requestSignal.throwIfAborted();
      const guarded=()=>{valid();requestSignal.throwIfAborted();if(adapter.effect==='write'){this.checkPreview(row);this.checkApproval(row,adapter);}};
      dispatched=true;let result=await adapter.execute(row.input,requestSignal,{agent,jobId:id,requestId:row.request_id,origin:row.origin,taskId:row.taskId,prepared:row.prepared,policyRevision:policy.revision,approvalExpires:row.approvalExpires,valid:guarded});requestSignal.throwIfAborted();valid();
      if(adapter.outputSchema)result=validateCapabilityInput(adapter.outputSchema,result);
      const resultLimit=Math.min(adapter.definition.maxResultBytes,policy.limits.maxResultBytes);
      if(adapter.effect==='read')result=boundedReadResult(result,resultLimit);
      else if(Buffer.byteLength(JSON.stringify(result??null))>resultLimit)fail('CAPABILITY_RESULT_TOO_LARGE');
      this.journal.transaction(()=>{valid();if(adapter.backend==='public-read'&&result?.digest)this.db.prepare('INSERT INTO human_page_snapshot VALUES(?,?,?,?,?) ON CONFLICT(agent,url) DO UPDATE SET digest=excluded.digest,fetched=excluded.fetched,job=excluded.job').run(agent,row.input.url,result.digest,result.fetchedAt,row.id);this.update(row,'completed',{result:result??{completed:true}});});
    }catch(error){
      const code=codeOf(error),writing=(adapter?.effect??row.capabilitySnapshot?.effect)==='write';
      if(writing&&dispatched)this.update(row,'unknown',{error:code==='CAPABILITY_OUTCOME_UNKNOWN'?code:'CAPABILITY_OUTCOME_UNKNOWN:'+code});
      else if((signal.aborted||code==='STALE_RESULT'||code==='CAPABILITY_CANCELLED')&&adapter?.definition.retrySafe)this.update(row,'suspended',{error:'OWNER_PREEMPTED'});
      else this.update(row,'failed',{error:code});
    }finally{this.inflight.delete(id);this.executions.delete(id);}return this.get(agent,id);
  }
}
export async function runToolTurn(agent,signal,job){
  const f=agent.factory,j=f.journal,epoch=agent.desired().epoch,remaining=j.value(agent.id,'remaining',0);if(remaining!==null&&remaining<=0){j.set(agent.id,'paused');return;}
  const valid=()=>{signal.throwIfAborted();j.assertAdmitted(agent.id);if(agent.desired().desired!=='running'||agent.desired().epoch!==epoch)throw new Error('STALE_RESULT');};agent.activeLane='action';
  try{await f.tools.execute(agent.id,job.id,{signal,valid});}
  finally{agent.activeLane=undefined;if(remaining!==null){j.put(agent.id,'remaining',Math.max(0,remaining-1));if(remaining<=1&&agent.desired().desired==='running'){j.set(agent.id,'paused');j.put(agent.id,'stopReason','cycle-limit');clearTimeout(agent.timer);agent.timer=undefined;}}if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length||f.tools.next(agent.id))agent.wake=true;}
}
