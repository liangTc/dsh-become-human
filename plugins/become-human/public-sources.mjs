import {createHash} from 'node:crypto';
import {researchUrl,fetchPublicDocument,sourceFailureDiagnostic} from './public-document.mjs';
import {sourceObservation,sourceItemPolicy} from './source-items.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error(code);};
const safeCode=error=>/^(?:SOURCE|PLUGIN_EVENT)_[A-Z_]{1,70}$/.test(error?.message??'')?error.message:'SOURCE_CHECK_FAILED';
export const publicSourcePolicy=Object.freeze({minIntervalMs:60000,maxIntervalMs:86400000,maxSources:32,eventLifetimeMs:86400000,maxConcurrentChecks:3,manualCheckCooldownMs:60000});

// Installed, trusted adapters configure explicit public URLs. Remote content
// cannot add URLs or change frequency. Collection never calls a model.
export class PublicSources {
  constructor(journal,events,{agentId,now=Date.now,fetch=fetchPublicDocument}={}){
    this.journal=journal;this.events=events;this.agentId=agentId;this.now=now;this.fetch=fetch;
    this.sources=new Map();this.jobs=new Set();this.closed=false;this.tickJob=null;
  }
  register(source,config){
    if(this.closed||this.sources.has(source)||this.sources.size>=publicSourcePolicy.maxSources||!config||Object.getPrototypeOf(config)!==Object.prototype||Object.keys(config).some(k=>!['url','title','intervalMs','emitInitial','format'].includes(k)))fail('SOURCE_CONFIG_INVALID');
    const url=researchUrl(config.url),title=config.title,intervalMs=config.intervalMs??600000,emitInitial=config.emitInitial??false;
    if(url.length>1200||typeof title!=='string'||!title.trim()||title.length>120||!Number.isSafeInteger(intervalMs)||intervalMs<publicSourcePolicy.minIntervalMs||intervalMs>publicSourcePolicy.maxIntervalMs||typeof emitInitial!=='boolean')fail('SOURCE_CONFIG_INVALID');
    const format=config.format??'auto';if(!['auto','feed','document'].includes(format))fail('SOURCE_CONFIG_INVALID');
    const normalized={url,title,intervalMs,emitInitial,format},fingerprint=hash(JSON.stringify({parser:sourceItemPolicy.version,...normalized}));
    const schema={type:'object',additionalProperties:false,properties:{sourceTitle:{type:'string'},title:{type:'string'},url:{type:'string',enum:[url]},finalUrl:{type:'string'},bodyDigest:{type:'string'},previousDigest:{type:'string'},preview:{type:'string'},previewTruncated:{type:'boolean'},watchFingerprint:{type:'string',enum:[fingerprint]},verified:{type:'boolean',enum:[false]},format:{type:'string'},change:{type:'string'},itemId:{type:'string'},itemUrl:{type:'string'},contentDigest:{type:'string'},previousContentDigest:{type:'string'},publishedAt:{type:'string'},updatedAt:{type:'string'},dateBasis:{type:'string'}},required:['title','url','finalUrl','bodyDigest','previousDigest','preview','previewTruncated','watchFingerprint','verified']};
    const handle=this.events.register(source,{version:1,title,inputSchema:schema}),r={source,config:normalized,fingerprint,handle,abort:new AbortController(),job:null};
    this.sources.set(source,r);
    const dispose=()=>{if(this.sources.get(source)!==r)return;r.abort.abort(Error('SOURCE_REMOVED'));this.sources.delete(source);handle.dispose();};
    return Object.freeze({check:()=>this.check(r),get:id=>handle.get(id),pending:()=>handle.pending(),status:()=>this.statusFor(r),dispose});
  }
  key(r){return 'publicSource:'+r.source;}
  valid(r,agent){r.abort.signal.throwIfAborted();if(this.closed||this.sources.get(r.source)!==r||agent!==this.agentId())fail('SOURCE_REMOVED');this.journal.assertAdmitted(agent);}
  saved(r,agent){const value=this.journal.value(agent,this.key(r),null);return value?.fingerprint===r.fingerprint?value:{fingerprint:r.fingerprint,digest:null,sequence:0,nextAt:0,failures:0};}
  statusFor(r){const agent=this.agentId();this.valid(r,agent);const s=this.saved(r,agent);return {source:r.source,...r.config,fingerprint:r.fingerprint,checking:!!r.job,manualCheckAvailableAt:s.manualRequestedAt==null?null:s.manualRequestedAt+publicSourcePolicy.manualCheckCooldownMs,initialized:!!s.digest,lastCheck:s.lastCheck??null,lastSuccess:s.lastSuccess??null,nextAt:s.nextAt,failures:s.failures,lastError:s.lastError??null,diagnostic:s.diagnostic??null,pendingPublication:!!s.pending,pendingItems:(s.pending?1:0)+(s.pendingItems?.length??0),observedFormat:s.observedFormat??null,knownItems:Object.keys(s.items??{}).length,noiseSuppressed:s.noiseSuppressed??0,expiredPublications:s.expiredPublications??0,lastEventId:s.lastEventId??null};}
  status(){return [...this.sources.values()].map(r=>this.statusFor(r));}
  requestCheck(source,fingerprint){
    const r=this.sources.get(source);if(!r)fail('SOURCE_NOT_REGISTERED');const agent=this.agentId();this.valid(r,agent);
    if(fingerprint!==r.fingerprint)fail('SOURCE_CONFIGURATION_CHANGED');if(r.job)return {state:'checking'};
    const s=this.saved(r,agent),now=this.now();if(s.manualRequestedAt!=null&&now-s.manualRequestedAt<publicSourcePolicy.manualCheckCooldownMs)fail('SOURCE_CHECK_TOO_SOON');
    this.journal.put(agent,this.key(r),{...s,nextAt:now,manualRequestedAt:now});
    this.journal.audit(agent,'public-source-check-requested',{source,fingerprint,origin:'owner'});void this.tick();return {state:'queued'};
  }
  check(r){
    if(r.job)return r.job;
    const job=this.collect(r);r.job=job;this.jobs.add(job);
    job.finally(()=>{r.job=null;this.jobs.delete(job);}).catch(()=>{});return job;
  }
  async collect(r){
    const agent=this.agentId();this.valid(r,agent);let s=this.saved(r,agent),now=this.now();
    if(s.nextAt>now)return {state:'deferred',nextAt:s.nextAt};
    const save=()=>{this.valid(r,agent);this.journal.put(agent,this.key(r),s);};
    try{
      // A pending envelope is committed before publish; replay keeps its exact
      // key, timestamps and bytes across a crash or a full downstream queue.
      while(s.pending&&s.pending.expiresAt<=now){
        this.journal.audit(agent,'public-source-event-expired',{source:r.source,key:s.pending.key});s={...s,expiredPublications:(s.expiredPublications??0)+1,pending:s.pendingItems?.[0]??null,pendingItems:(s.pendingItems??[]).slice(1)};save();
      }
      if(!s.pending&&s.pendingSnapshot){s={...s,...s.pendingSnapshot,pendingSnapshot:null};save();}
      if(!s.pending){
        const document=await this.fetch(r.config.url,r.abort.signal);this.valid(r,agent);now=this.now();
        if(document.truncated)fail('SOURCE_BODY_TRUNCATED');
        if(researchUrl(document.url).length>1200)fail('SOURCE_URL_TOO_LONG');
        const observation=sourceObservation(document,r.config),digest=observation.digest,rawDigest=hash(JSON.stringify([document.url,document.type,document.body])),previousRaw=s.rawDigest;
        const items={...(s.items??{})};let changes;
        if(observation.items){
          changes=observation.items.filter(row=>items[row.key]!==row.digest).map(row=>({...row,change:items[row.key]?'updated':'new',previousContentDigest:items[row.key]??''}));
          for(const row of observation.items)items[row.key]=row.digest;
          if(Object.keys(items).length>sourceItemPolicy.maxHistory)fail('SOURCE_FEED_HISTORY_FULL');
        }else changes=digest===s.digest?[]:[{title:r.config.title,content:observation.content}];
        const snapshot={digest,rawDigest,items,observedFormat:observation.format};
        s={...s,lastCheck:now,lastSuccess:now,lastError:null,diagnostic:null,failures:0,nextAt:now+r.config.intervalMs};
        if(!s.digest&&!r.config.emitInitial){s={...s,...snapshot};save();this.journal.audit(agent,'public-source-baseline',{source:r.source,format:observation.format,items:observation.items?.length??0});return {state:'baseline'};}
        if(!changes.length){s={...s,...snapshot,noiseSuppressed:(s.noiseSuppressed??0)+(previousRaw&&rawDigest!==previousRaw?1:0)};save();return {state:'unchanged'};}
        const envelopes=changes.map(row=>{
          const payload={sourceTitle:r.config.title,title:row.title.slice(0,240)||r.config.title,url:r.config.url,finalUrl:document.url,bodyDigest:rawDigest,previousDigest:s.rawDigest??'',preview:row.content.slice(0,1600),previewTruncated:row.content.length>1600||row.title.length>240,watchFingerprint:r.fingerprint,verified:false,format:observation.format,...(observation.items?{change:row.change,itemId:row.id,itemUrl:row.link??'',contentDigest:row.digest,previousContentDigest:row.previousContentDigest,publishedAt:row.publishedAt??'',updatedAt:row.updatedAt??'',dateBasis:'publisher-reported-not-verified'}:{})};
          while(Buffer.byteLength(JSON.stringify(payload))>7000&&payload.preview.length){payload.preview=payload.preview.slice(0,-100);payload.previewTruncated=true;}
          if(Buffer.byteLength(JSON.stringify(payload))>7000)fail('SOURCE_PREVIEW_TOO_LARGE');
          const sequence=++s.sequence;
          return {key:hash(r.fingerprint+':'+sequence+':'+(row.key??digest)+':'+(row.digest??digest)),occurredAt:now,expiresAt:now+publicSourcePolicy.eventLifetimeMs,payload};
        });
        s={...s,pending:envelopes[0],pendingItems:envelopes.slice(1),pendingSnapshot:snapshot};save();
      }
      const eventIds=[];let published;
      while(s.pending){
        this.valid(r,agent);published=r.handle.publish(s.pending);eventIds.push(published.id);
        s={...s,pending:s.pendingItems?.[0]??null,pendingItems:(s.pendingItems??[]).slice(1),lastEventId:published.id,failures:0,lastError:null,diagnostic:null,nextAt:this.now()+r.config.intervalMs};
        if(!s.pending&&s.pendingSnapshot)s={...s,...s.pendingSnapshot,pendingSnapshot:null};save();
        this.journal.audit(agent,'public-source-change',{source:r.source,eventId:published.id,duplicate:published.duplicate});
      }
      return {state:'published',eventId:published.id,eventIds,duplicate:published.duplicate};
    }catch(error){
      // Revocation/cancellation cannot publish or save a stale observation.
      this.valid(r,agent);const code=safeCode(error),failures=Math.min((s.failures??0)+1,20),diagnostic=sourceFailureDiagnostic(error);
      const previousError=s.lastError;
      s={...s,lastCheck:this.now(),lastError:code,diagnostic,failures,nextAt:this.now()+Math.min(86400000,r.config.intervalMs*2**Math.min(failures,10))};save();
      if(previousError!==code)this.journal.audit(agent,'public-source-check-failed',{source:r.source,code,diagnostic,nextAt:s.nextAt});
      return {state:'failed',code,nextAt:s.nextAt,diagnostic};
    }
  }
  tick(){
    if(this.closed)return Promise.resolve();if(this.tickJob)return this.tickJob;
    const rows=[...this.sources.values()];let cursor=0;
    const worker=async()=>{while(!this.closed&&cursor<rows.length){const r=rows[cursor++];try{await this.check(r);}catch{/* disposal/retirement; no model or implicit restart */}}};
    const job=Promise.all(Array.from({length:Math.min(publicSourcePolicy.maxConcurrentChecks,rows.length)},worker));
    this.tickJob=job;job.finally(()=>{this.tickJob=null;}).catch(()=>{});return job;
  }
  start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.tick(),15000);this.timer.unref?.();}
  async close(){
    this.closed=true;clearInterval(this.timer);this.timer=null;
    for(const r of this.sources.values()){r.abort.abort(Error('SOURCE_REMOVED'));r.handle.dispose();}this.sources.clear();
    await Promise.allSettled([...this.jobs,...(this.tickJob?[this.tickJob]:[])]);
  }
}
