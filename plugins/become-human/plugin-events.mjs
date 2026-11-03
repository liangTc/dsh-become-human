import {createHash,randomUUID} from 'node:crypto';
import {assertCapabilitySchema,validateCapabilityInput,plain} from './capability-schema.mjs';
import {attentionWindow} from './attention-window.mjs';

const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const fail=code=>{throw Error(code);};
export const pluginEventPolicy=Object.freeze({contractVersion:1,maxPayloadBytes:8192,maxPendingPerSource:64,maxRetainedPerAgent:2048,maxLifetimeMs:7*86400000,wakeCooldownMs:60000});

export class PluginEvents {
  constructor(journal,{agentId,wake=()=>{},now=Date.now}={}){
    this.journal=journal;this.db=journal.db;this.agentId=agentId;this.wake=wake;this.now=now;this.sources=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_plugin_event(
      id TEXT PRIMARY KEY,agent TEXT NOT NULL,source TEXT NOT NULL,event_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
      digest TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,
      UNIQUE(agent,source,event_key));
      CREATE INDEX IF NOT EXISTS human_plugin_event_pending ON human_plugin_event(agent,status,created);`);
  }
  register(source,descriptor){
    if(typeof source!=='string'||!/^[a-z][a-z0-9._:-]{0,119}$/.test(source)||this.sources.has(source)||this.sources.size>=64||!plain(descriptor)||!Number.isSafeInteger(descriptor.version)||descriptor.version<1||typeof descriptor.title!=='string'||!descriptor.title.trim()||descriptor.title.length>120)fail('INVALID_PLUGIN_EVENT_SOURCE');
    assertCapabilitySchema(descriptor.inputSchema);
    const definition=structuredClone({source,version:descriptor.version,title:descriptor.title,inputSchema:descriptor.inputSchema}),fingerprint=digest(definition),registration={definition,fingerprint};this.sources.set(source,registration);
    const assertLive=()=>{if(this.sources.get(source)!==registration)fail('PLUGIN_EVENT_SOURCE_REMOVED');const id=this.agentId();this.journal.assertAdmitted(id);return id;};
    return Object.freeze({
      publish:event=>{const id=assertLive();return this.publish(id,registration,event);},
      pending:()=>{const id=assertLive();return this.events(id,{source});},
      get:eventId=>{const id=assertLive();const row=this.db.prepare("SELECT id,data,created FROM human_plugin_event WHERE agent=? AND source=? AND fingerprint=? AND id=? AND status IN ('pending','claimed') AND expires>?").get(id,source,fingerprint,eventId,this.now());return row?{...row,kind:'plugin',data:JSON.parse(row.data)}:null;},
      dispose:()=>{if(this.sources.get(source)===registration)this.sources.delete(source);},
    });
  }
  publish(agent,registration,event){
    const now=this.now(),p=pluginEventPolicy;
    if(!plain(event)||Object.keys(event).some(k=>!['key','occurredAt','expiresAt','payload'].includes(k))||typeof event.key!=='string'||!event.key.trim()||event.key.length>160||/[\u0000-\u001f]/.test(event.key)||!Number.isSafeInteger(event.occurredAt)||!Number.isSafeInteger(event.expiresAt)||event.occurredAt>now+60000||event.occurredAt<now-p.maxLifetimeMs||event.expiresAt<=now||event.expiresAt<=event.occurredAt||event.expiresAt>event.occurredAt+p.maxLifetimeMs)fail('INVALID_PLUGIN_EVENT');
    const payload=validateCapabilityInput(registration.definition.inputSchema,event.payload);
    const encoded=JSON.stringify(payload);if(Buffer.byteLength(encoded)>p.maxPayloadBytes)fail('PLUGIN_EVENT_TOO_LARGE');
    const source=registration.definition.source,fingerprint=registration.fingerprint,body={source,sourceVersion:registration.definition.version,fingerprint,origin:'external-plugin',untrusted:true,occurredAt:event.occurredAt,expiresAt:event.expiresAt,payload:JSON.parse(encoded)},hash=digest(body);
    let result;
    this.journal.transaction(()=>{
      const prior=this.db.prepare('SELECT id,digest,status FROM human_plugin_event WHERE agent=? AND source=? AND event_key=?').get(agent,source,event.key);
      if(prior){if(prior.digest!==hash)fail('PLUGIN_EVENT_KEY_CONFLICT');result={id:prior.id,duplicate:true,status:prior.status};return;}
      // Expired events cannot be reintroduced with their original timestamp.
      // Retain unexpired deduplication receipts even after completion.
      this.db.prepare('DELETE FROM human_plugin_event WHERE agent=? AND expires<=?').run(agent,now);
      if(this.db.prepare('SELECT count(*) n FROM human_plugin_event WHERE agent=?').get(agent).n>=p.maxRetainedPerAgent||this.db.prepare("SELECT count(*) n FROM human_plugin_event WHERE agent=? AND source=? AND status='pending'").get(agent,source).n>=p.maxPendingPerSource)fail('PLUGIN_EVENT_QUEUE_FULL');
      const id=randomUUID();this.db.prepare("INSERT INTO human_plugin_event VALUES(?,?,?,?,?,?,?,'pending',?,?)").run(id,agent,source,event.key,fingerprint,hash,JSON.stringify(body),now,event.expiresAt);
      this.journal.audit(agent,'plugin-event-received',{eventId:id,source,sourceVersion:body.sourceVersion,payloadDigest:hash,expiresAt:event.expiresAt});result={id,duplicate:false,status:'pending'};
    });
    if(!result.duplicate)this.wake(agent);
    return result;
  }
  entries(agent){
    if(!this.sources.size)return [];
    const clauses=[...this.sources].map(()=>'(source=? AND fingerprint=?)').join(' OR '),parameters=[...this.sources].flatMap(([source,r])=>[source,r.fingerprint]);
    // Rank metadata only. Decode payloads for the small visible window.
    return this.db.prepare(`SELECT id,source FROM human_plugin_event WHERE agent=? AND status='pending' AND expires>? AND (${clauses}) ORDER BY created,id`).all(agent,this.now(),...parameters).map(row=>({key:row.id,group:row.source}));
  }
  events(agent,{source,advance=false,limit=16}={}){
    const entries=this.entries(agent).filter(row=>!source||row.group===source);
    const selected=attentionWindow(this.journal,agent,'plugin-events',entries,{limit,advance,perGroupLimit:8});
    const get=this.db.prepare('SELECT id,data,created FROM human_plugin_event WHERE agent=? AND id=?');
    return selected.map(entry=>{const row=get.get(agent,entry.key);return {...row,kind:'plugin',data:JSON.parse(row.data)};});
  }
  valid(agent,ids=[]){
    return ids.every(id=>{const row=this.db.prepare('SELECT source,fingerprint,expires,status FROM human_plugin_event WHERE agent=? AND id=?').get(agent,id);return !!row&&row.status!=='handled'&&row.expires>this.now()&&this.sources.get(row.source)?.fingerprint===row.fingerprint;});
  }
  context(agent,ids=[]){
    this.journal.assertAdmitted(agent);
    if(!Array.isArray(ids)||ids.length>512||ids.some(id=>typeof id!=='string'||id.length>64))fail('INVALID_BEHAVIOR_EVENT_REFERENCES');
    // Only the events referenced by visible opportunities are supplied. This
    // read neither advances attention nor claims/acknowledges queued work.
    const get=this.db.prepare('SELECT * FROM human_plugin_event WHERE agent=? AND id=?');
    return [...new Set(ids)].map(id=>{
      const row=get.get(agent,id);
      if(!row||!this.valid(agent,[id]))return {id,available:false};
      const data=JSON.parse(row.data);
      return {id,available:true,source:row.source,sourceVersion:data.sourceVersion,fingerprint:row.fingerprint,digest:row.digest,occurredAt:data.occurredAt,expiresAt:row.expires,origin:'external-plugin',untrusted:true,ownerFact:false,payload:data.payload};
    });
  }
  claim(agent,ids=[]){
    if(!this.valid(agent,ids))fail('PLUGIN_EVENT_UNAVAILABLE');
    for(const id of ids)this.db.prepare("UPDATE human_plugin_event SET status='claimed' WHERE agent=? AND id=? AND status='pending'").run(agent,id);
  }
  complete(agent,ids=[]){
    for(const id of ids){const changed=this.db.prepare("UPDATE human_plugin_event SET status='handled' WHERE agent=? AND id=? AND status='claimed'").run(agent,id);if(changed.changes)this.journal.audit(agent,'plugin-event-handled',{eventId:id,meaning:'selected-behavior-finished-not-owner-satisfaction'});}
  }
  status(agent){return {policy:pluginEventPolicy,sources:[...this.sources.values()].map(({definition})=>({id:definition.source,title:definition.title,version:definition.version})),pending:this.db.prepare("SELECT count(*) n FROM human_plugin_event WHERE agent=? AND status='pending' AND expires>?").get(agent,this.now()).n,claimed:this.db.prepare("SELECT count(*) n FROM human_plugin_event WHERE agent=? AND status='claimed' AND expires>?").get(agent,this.now()).n,available:this.events(agent).length};}
}

export function wakeForPluginEvent(factory,id){
  const j=factory.journal,now=Date.now(),agent=[...factory.handles].map(h=>h.agent).find(a=>a?.id===id);
  if(!agent?.ready||agent.closed||agent.active||agent.desired().desired!=='running'||!factory.autonomy.settings(id).enabled||j.value(id,'autonomyPaused',false)||j.value(id,'autonomyError',null)||now-j.value(id,'pluginEventLastWake',0)<pluginEventPolicy.wakeCooldownMs)return;
  j.put(id,'pluginEventLastWake',now);j.audit(id,'plugin-event-wake',{});agent.wake=true;agent.pump();
}
