import {createHash} from 'node:crypto';
import {scheduledRule,occurrence} from './scheduled-tasks.mjs';
import {quietUntil} from './quiet-hours.mjs';
import {pluginEventPolicy} from './plugin-events.mjs';

const ownerName=/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,120}$/;
export const pluginResourceId=(owner,id)=>'p.'+hash(owner).slice(0,16)+':'+id;
const localName=/^[a-z][a-z0-9.-]{0,47}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=value=>{const text=JSON.stringify(value);if(text===undefined||Buffer.byteLength(text)>16384)throw Error('PLUGIN_HOOK_OUTPUT_INVALID');return JSON.parse(text);};
const phases=new Set(['input','selection','result','feedback','memory','growth','delivery']);
export function lifecyclePhase(kind){
  if(kind==='conversation-input-published')return 'input';
  if(kind==='activity-result')return 'result';
  if(['event-feedback','note-revised','learning-follow-up-committed'].includes(kind))return 'feedback';
  if(['memory-lifecycle-maintained','memory-lifecycle-summary-committed','memory-lifecycle-batch-restored'].includes(kind))return 'memory';
  if(/^(?:memory-(?:saved|revised|forgotten|archived|restored)|dialogue-summary-committed)$/.test(kind))return 'memory';
  if(/^(?:persona-development-(?:applied|reverted)|experience-reflected|development-review-completed)$/.test(kind))return 'growth';
  if(kind==='response-published')return 'delivery';
  return null;
}

// Registration and lifecycle callbacks are local, synchronous contributions.
// They may publish typed events, never start models or deliver messages. Those
// actions remain behind Human's ordinary selection/execution/approval gates.
export class HumanPlugins {
  constructor(factory,{getSession=()=>factory.controllerSessionId,now=Date.now}={}){
    this.factory=factory;this.journal=factory.journal;this.db=this.journal.db;this.getSession=getSession;this.now=now;this.entries=new Map();this.pages=null;this.timer=null;
    this.db.exec('CREATE TABLE IF NOT EXISTS human_plugin_schedule(agent TEXT,owner TEXT,id TEXT,definition TEXT,rule TEXT,due INTEGER,status TEXT,error TEXT,PRIMARY KEY(agent,owner,id));');
  }
  service(){return Object.freeze({contractVersion:1,resourceId:pluginResourceId,register:(owner,descriptor)=>this.register(owner,descriptor)});}
  register(owner,d){
    if(!ownerName.test(owner)||this.entries.has(owner)||this.entries.size>=64||d?.version!==1||typeof d.title!=='string'||!d.title.trim()||d.title.length>64)throw Error('PLUGIN_REGISTRATION_INVALID');
    const hooks=d.hooks??{};if(Object.entries(hooks).some(([phase,fn])=>!phases.has(phase)||typeof fn!=='function'))throw Error('PLUGIN_HOOK_INVALID');
    const entry={owner,title:d.title,description:String(d.description??'').slice(0,300),hooks,held:new Set(),cleanups:[],events:new Map(),schedules:[],counts:{},disposed:false};
    const add=(kind,rows,register)=>{if(rows===undefined)return;if(!Array.isArray(rows)||rows.length>32)throw Error('PLUGIN_REGISTRATION_INVALID');entry.counts[kind]=rows.length;for(const row of rows){if(!localName.test(row.id))throw Error('PLUGIN_REGISTRATION_INVALID');const cleanup=register(row);entry.cleanups.push(typeof cleanup==='function'?cleanup:()=>cleanup.dispose());}};
    const id=this.getSession();this.journal.assertAdmitted(id);
    try{
      this.journal.transaction(()=>{
        add('events',d.events,row=>{const handle=this.factory.pluginEvents.register(pluginResourceId(owner,row.id),row.descriptor);entry.events.set(row.id,handle);return handle;});
        add('behaviors',d.behaviors,row=>this.factory.behaviors.register(pluginResourceId(owner,row.id),row.descriptor));
        add('capabilities',d.capabilities,row=>this.factory.tools.register(pluginResourceId(owner,row.id),row.descriptor));
        add('sources',d.sources,row=>this.factory.publicSources.register(pluginResourceId(owner,row.id),row.descriptor));
        add('pages',d.pages,row=>{if(!this.pages)throw Error('PLUGIN_PAGES_UNAVAILABLE');return this.pages.register(owner,row.id,row.handlers);});
        if(d.learning){entry.cleanups.push(this.factory.learningPack.register(d.learning));entry.counts.workflows=1;}
        if(d.schedules!==undefined&&(!Array.isArray(d.schedules)||d.schedules.length>32))throw Error('PLUGIN_SCHEDULE_INVALID');
        for(const schedule of d.schedules??[]){
          if(!localName.test(schedule.id)||entry.schedules.includes(schedule.id)||!entry.events.has(schedule.source))throw Error('PLUGIN_SCHEDULE_INVALID');
          const missedPolicy=schedule.missedPolicy===undefined?'latest':schedule.missedPolicy;
          if(!['latest','all'].includes(missedPolicy))throw Error('PLUGIN_SCHEDULE_INVALID');
          // Omit the default from the digest so existing clocks and one-shot
          // completion receipts survive an upgrade or an explicit "latest".
          const definition=json({source:schedule.source,payload:schedule.payload??{},title:schedule.title,rule:schedule.rule,...(missedPolicy==='all'?{missedPolicy}:{})}),digest=hash(definition),prior=this.db.prepare('SELECT * FROM human_plugin_schedule WHERE agent=? AND owner=? AND id=?').get(id,owner,schedule.id);
          // Same definition resumes the durable clock, including one-shot done.
          if(!prior||JSON.parse(prior.definition).digest!==digest){
            const rule=scheduledRule(schedule.id,{title:schedule.title,prompt:schedule.title,rule:schedule.rule},this.now());
            this.db.prepare("INSERT INTO human_plugin_schedule VALUES(?,?,?,?,?,?,'pending',NULL) ON CONFLICT(agent,owner,id) DO UPDATE SET definition=excluded.definition,rule=excluded.rule,due=excluded.due,status='pending',error=NULL").run(id,owner,schedule.id,JSON.stringify({...definition,digest}),JSON.stringify(rule),Date.parse(rule.scheduledAt));
          }else if(prior.status==='held'&&prior.error==='PLUGIN_EVENT_QUEUE_FULL'){
            this.db.prepare("UPDATE human_plugin_schedule SET status='pending',due=? WHERE agent=? AND owner=? AND id=?").run(this.now(),id,owner,schedule.id);
          }
          entry.schedules.push(schedule.id);
        }
        const cursor='plugin-cursor:'+owner;if(this.journal.value(id,cursor,null)===null)this.journal.put(id,cursor,this.db.prepare('SELECT max(seq) n FROM audit WHERE agent=?').get(id).n??0);
      });
      this.entries.set(owner,entry);
    }catch(error){for(const cleanup of entry.cleanups.reverse())try{cleanup();}catch{}throw error;}
    const dispose=()=>{if(entry.disposed)return;entry.disposed=true;this.entries.delete(owner);for(const cleanup of entry.cleanups.reverse())try{cleanup();}catch{};};
    return Object.freeze({dispose,publish:(source,event)=>{if(entry.disposed)throw Error('PLUGIN_DISPOSED');const handle=entry.events.get(source);if(!handle)throw Error('PLUGIN_EVENT_NOT_REGISTERED');return handle.publish(event);}});
  }
  invoke(entry,phase,event){
    if(!entry.hooks[phase]||entry.held.has(phase))return;
    const id=this.getSession(),stateKey='plugin-state:'+entry.owner;
    try{this.journal.transaction(()=>{
      const output=entry.hooks[phase](json(event),Object.freeze({state:json(this.journal.value(id,stateKey,{})),now:this.now()}));
      if(output?.then){output.catch?.(()=>{});throw Error('PLUGIN_HOOK_MUST_BE_SYNCHRONOUS');}
      if(output===undefined)return;const value=json(output);
      if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['state','events'].includes(k))||value.events!==undefined&&(!Array.isArray(value.events)||value.events.length>8))throw Error('PLUGIN_HOOK_OUTPUT_INVALID');
      if(value.state!==undefined)this.journal.put(id,stateKey,value.state);
      for(const proposal of value.events??[]){const source=entry.events.get(proposal.source);if(!source)throw Error('PLUGIN_EVENT_NOT_REGISTERED');source.publish(proposal.event);}
    });}catch(error){entry.held.add(phase);this.journal.audit(id,'plugin-hook-held',{owner:entry.owner,phase,code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'PLUGIN_HOOK_FAILED'});}
  }
  selection(event){this.pump();for(const entry of this.entries.values())this.invoke(entry,'selection',event);}
  pump(){
    const id=this.getSession();if(!id||this.factory.closing||this.journal.get(id)?.desired!=='running')return;
    this.journal.assertAdmitted(id);
    // A fixed snapshot prevents hooks from consuming their own emitted events.
    const ceiling=this.db.prepare('SELECT max(seq) n FROM audit WHERE agent=?').get(id).n??0;
    for(const entry of this.entries.values()){
      const key='plugin-cursor:'+entry.owner,cursor=this.journal.value(id,key,ceiling),rows=this.db.prepare('SELECT seq,kind,data FROM audit WHERE agent=? AND seq>? AND seq<=? ORDER BY seq LIMIT 200').all(id,cursor,ceiling);
      if(rows.length)this.journal.transaction(()=>{for(const row of rows){const phase=lifecyclePhase(row.kind);if(phase)this.invoke(entry,phase,{id:'audit:'+row.seq,phase,kind:row.kind,...JSON.parse(row.data)});}this.journal.put(id,key,rows.at(-1).seq);});
    }
    const settings=this.factory.autonomy.settings(id),now=this.now();
    if(this.journal.value(id,'autonomyPaused',false)||this.journal.value(id,'autonomyError',null)||!settings.enabled||quietUntil(settings,now)!==null)return;
    for(const entry of this.entries.values())for(const scheduleId of entry.schedules){
      const row=this.db.prepare("SELECT * FROM human_plugin_schedule WHERE agent=? AND owner=? AND id=? AND status='pending' AND due<=?").get(id,entry.owner,scheduleId,this.now());if(!row)continue;
      try{this.journal.transaction(()=>{
        const definition=JSON.parse(row.definition),rule=JSON.parse(row.rule);
        const oldest=now-pluginEventPolicy.maxLifetimeMs;
        const checkAt=definition.missedPolicy==='all'?Math.max(Date.parse(rule.scheduledAt),oldest):now;
        const decision=occurrence(row,checkAt),at=Date.parse(decision.occurrenceAt),next=decision.nextScheduledAt;
        if(at>oldest){
          entry.events.get(definition.source).publish({key:'schedule:'+scheduleId+':'+definition.digest.slice(0,12)+':'+at,occurredAt:at,expiresAt:at+pluginEventPolicy.maxLifetimeMs,payload:definition.payload});
        }
        this.db.prepare('UPDATE human_plugin_schedule SET rule=?,due=?,status=?,error=NULL WHERE agent=? AND owner=? AND id=?').run(JSON.stringify({...rule,...(next?{scheduledAt:next}:{})}),next?Date.parse(next):at,next?'pending':'completed',id,entry.owner,scheduleId);
        this.journal.audit(id,at>oldest?'plugin-schedule-triggered':'plugin-schedule-expired',{owner:entry.owner,scheduleId,occurrenceAt:decision.occurrenceAt,nextAt:next??null});
      });}catch(error){
        const code=/^[A-Z_]{3,80}$/.test(error.message)?error.message:'PLUGIN_SCHEDULE_FAILED';
        if(code==='PLUGIN_EVENT_QUEUE_FULL'){
          // Keep rule.scheduledAt intact. Only the next admission check moves.
          this.db.prepare('UPDATE human_plugin_schedule SET due=?,error=? WHERE agent=? AND owner=? AND id=?').run(now+60000,code,id,entry.owner,scheduleId);
          if(row.error!==code)this.journal.audit(id,'plugin-schedule-deferred',{owner:entry.owner,scheduleId,code});
        }else{
          this.db.prepare("UPDATE human_plugin_schedule SET status='held',error=? WHERE agent=? AND owner=? AND id=?").run(code,id,entry.owner,scheduleId);
          this.journal.audit(id,'plugin-schedule-held',{owner:entry.owner,scheduleId,code});
        }
      }
    }
  }
  catalog(){const id=this.getSession();return [...this.entries.values()].map(e=>({owner:e.owner,title:e.title,description:e.description,counts:e.counts,hooks:Object.keys(e.hooks),held:[...e.held],schedules:this.db.prepare('SELECT id,rule,due,status,error FROM human_plugin_schedule WHERE agent=? AND owner=?').all(id,e.owner).filter(r=>e.schedules.includes(r.id)).map(r=>({id:r.id,title:JSON.parse(r.rule).title,nextAt:r.status==='pending'?r.due:null,status:r.status,error:r.error}))}));}
  start(){if(this.timer)return;this.timer=setInterval(()=>{try{this.pump();}catch{}},1000);this.timer.unref?.();}
  close(){clearInterval(this.timer);this.timer=null;for(const e of this.entries.values()){e.disposed=true;for(const cleanup of e.cleanups.reverse())try{cleanup();}catch{}}this.entries.clear();}
}
