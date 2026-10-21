import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {protectKey} from './dpapi.mjs';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {quotaView,quotaAllows} from './quota.mjs';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function protect(operation,value){
  return protectKey(operation,value);
}
async function atomic(file,data){const temp=file+'.'+crypto.randomUUID()+'.tmp';const handle=await fs.open(temp,'wx');try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}await fs.rename(temp,file);}
export class SafetyLedger {
  static async open(root){const ledger=new SafetyLedger(path.resolve(root));await ledger.init();return ledger;}
  constructor(root){this.root=root;this.rows=[];this.blocked=false;}
  async init(){
    await fs.mkdir(this.root,{recursive:true});if(await fs.realpath(this.root)!==this.root)throw new Error('LINKED_CONTROL_ROOT');
    const keyFile=path.join(this.root,'key.dpapi'),anchorFile=path.join(this.root,'anchor.json'),dbFile=path.join(this.root,'control.sqlite');
    let anchor;try{anchor=JSON.parse(await fs.readFile(anchorFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('BLOCKED_CONTROL_HISTORY');}
    let sealed;try{sealed=await fs.readFile(keyFile,'utf8');}catch(e){if(e.code!=='ENOENT'||anchor)throw new Error('BLOCKED_CONTROL_KEY');sealed=await protect('protect',randomBytes(32).toString('hex'));await atomic(keyFile,sealed);}
    this.key=Buffer.from(await protect('unprotect',sealed),'hex');if(this.key.length!==32)throw new Error('BLOCKED_CONTROL_KEY');
    if(anchor){try{await fs.stat(dbFile);}catch{throw new Error('BLOCKED_CONTROL_HISTORY');}}
    this.db=new DatabaseSync(dbFile);this.db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS identity(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS instruction(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,kind TEXT,request_hash TEXT,data TEXT,previous TEXT,hash TEXT,phase TEXT);`);
    if(!this.db.prepare('SELECT id FROM identity').get())this.db.prepare('INSERT INTO identity VALUES(?)').run(crypto.randomUUID());
    this.id=this.db.prepare('SELECT id FROM identity').get().id;this.reload();
    if(anchor&&(anchor.id!==this.id||anchor.keyId!==this.mac('key-identity')||anchor.seq>this.rows.length||anchor.seq>0&&this.rows[anchor.seq-1].hash!==anchor.hash))throw new Error('BLOCKED_CONTROL_HISTORY');
    await this.anchor();
  }
  mac(value){return createHmac('sha256',this.key).update(JSON.stringify(value)).digest('hex');}
  reload(){
    this.rows=this.db.prepare('SELECT * FROM instruction ORDER BY seq').all();let previous='';
    for(const [i,row] of this.rows.entries()){
      if(row.seq!==i+1||row.previous!==previous||row.hash!==this.mac({seq:row.seq,id:row.id,kind:row.kind,request_hash:row.request_hash,data:row.data,previous:row.previous}))throw new Error('BLOCKED_CONTROL_HISTORY');previous=row.hash;
    }
    this.budget={legacyUsed:0,base:0,round:null,allowance:0,localQuotaEnabled:true,entries:new Map()};
    for(const row of this.rows){const data=JSON.parse(row.data);
      if(row.kind==='budget-initial')Object.assign(this.budget,{legacyUsed:data.used,base:data.used,round:data.round,allowance:data.allowance});
      if(row.kind==='budget-round')Object.assign(this.budget,{base:data.base,round:data.round,allowance:data.allowance});
      if(row.kind==='budget-reserve')this.budget.entries.set(data.rid,{rid:data.rid,amount:data.amount,status:'prepared',agent:data.agent,budgetClass:data.budgetClass??'legacy',created:data.created??0,roundId:data.roundId});
      if(row.kind==='budget-dispatch'&&this.budget.entries.has(data.rid))this.budget.entries.get(data.rid).status='dispatched';
      if(row.kind==='budget-settle'&&this.budget.entries.has(data.rid))Object.assign(this.budget.entries.get(data.rid),{amount:data.amount,status:'settled'});
      if(row.kind==='budget-release'&&this.budget.entries.has(data.rid))Object.assign(this.budget.entries.get(data.rid),{amount:0,status:'released'});
      if(row.kind==='quota-policy')this.budget.localQuotaEnabled=data.enabled;
    }
  }
  used(){return this.budget.legacyUsed+[...this.budget.entries.values()].reduce((n,r)=>n+r.amount,0);}
  appendSync(id,kind,data){
    const requestHash=hash({kind,data}),prior=this.rows.find(r=>r.id===id);if(prior){if(prior.request_hash!==requestHash)throw new Error('REQUEST_ID_CONFLICT');return prior;}
    const body={seq:this.rows.length+1,id,kind,request_hash:requestHash,data:JSON.stringify(data),previous:this.rows.at(-1)?.hash??''};
    this.db.prepare("INSERT INTO instruction VALUES(?,?,?,?,?,?,?,'prepared')").run(body.seq,id,kind,requestHash,body.data,body.previous,this.mac(body));this.reload();return this.rows.at(-1);
  }
  async configureBudget(round,allowance,used){
    if(!this.budget.round)this.appendSync('budget-initial','budget-initial',{used,round,allowance});
    else if(this.budget.round!==round)this.appendSync('round:'+round,'budget-round',{base:this.used(),round,allowance});
    else if(this.budget.allowance!==allowance)throw new Error('BUDGET_ROUND_CONFIG_CONFLICT');
    for(const [rid,row] of this.budget.entries)if(row.status==='prepared')this.releaseBudget(rid);else if(row.status==='dispatched')this.settleBudget(rid);
    const open=new Map();for(const row of this.rows){if(row.kind==='autonomy-segment-start'){const d=JSON.parse(row.data);open.set(d.id,d);}if(row.kind==='autonomy-segment-end')open.delete(JSON.parse(row.data).id);}
    for(const d of open.values())this.appendSync('segment-end:'+d.id,'autonomy-segment-end',{...d,used:d.maxMs,recovered:true});
    await this.anchor();
  }
  async configureLocalQuota(enabled){if(typeof enabled!=='boolean')throw new Error('INVALID_QUOTA_POLICY');if(this.budget.localQuotaEnabled!==enabled)this.appendSync('quota:'+crypto.randomUUID(),'quota-policy',{enabled});await this.anchor();}
  autonomyPolicy(agent){return this.rows.filter(r=>r.kind==='autonomy-policy').map(r=>JSON.parse(r.data)).findLast(p=>p.agent===agent)?.settings;}
  autonomyAgents(agent){const ids=new Set([agent]);for(const row of [...this.rows].reverse())if(row.kind==='retire'){const data=JSON.parse(row.data);if(ids.has(data.newId))ids.add(data.oldId);}return ids;}
  autonomyEntries(agent,start){const ids=this.autonomyAgents(agent);return [...this.budget.entries.values()].filter(e=>ids.has(e.agent)&&e.budgetClass==='autonomous'&&e.created>=start&&e.status!=='released');}
  autonomyGrants(agent,now){const revoked=new Set(this.rows.filter(r=>r.kind==='autonomy-grant-revoke').map(r=>JSON.parse(r.data)).filter(g=>g.agent===agent).map(g=>g.id));return this.rows.filter(r=>r.kind==='autonomy-grant').map(r=>JSON.parse(r.data)).filter(g=>g.agent===agent&&!revoked.has(g.id)&&g.created<=now&&g.expires>now);}
  reserveBudget(rid,agent,amount,options={}){
    const budgetClass=options.budgetClass??'legacy',created=options.created??Date.now();
    if(!['legacy','autonomous','foreground'].includes(budgetClass))throw new Error('INVALID_BUDGET_CLASS');
    if(budgetClass==='legacy'&&this.budget.localQuotaEnabled&&this.used()+amount-this.budget.base>this.budget.allowance)return false;
    if(budgetClass==='autonomous'){
      const policy=this.autonomyPolicy(agent);if(!policy?.enabled)throw new Error('AUTONOMY_DISABLED');
      const view=quotaView(this,agent,policy,created);
      if(!quotaAllows(view,{tokens:amount,requests:1,roundId:options.roundId??'legacy:'+rid}))return false;
    }
    this.appendSync('reserve:'+rid,'budget-reserve',{rid,agent,amount,budgetClass,created,...(options.roundId?{roundId:options.roundId}:{})});return true;
  }
  dispatchBudget(rid){const row=this.budget.entries.get(rid);if(!row||row.status!=='prepared')throw new Error('INVALID_BUDGET_TICKET');this.appendSync('dispatch:'+rid,'budget-dispatch',{rid});}
  settleBudget(rid,actual){const row=this.budget.entries.get(rid);if(!row||row.status==='released')return;const amount=actual===undefined?row.amount:Math.max(row.amount,actual);if(row.status==='settled'&&row.amount===amount)return;this.appendSync('settle:'+rid+':'+amount,'budget-settle',{rid,amount});}
  releaseBudget(rid){const row=this.budget.entries.get(rid);if(row?.status!=='prepared')return;this.appendSync('release:'+rid,'budget-release',{rid});}
  async anchor(){const last=this.rows.at(-1);await atomic(path.join(this.root,'anchor.json'),JSON.stringify({id:this.id,keyId:this.mac('key-identity'),seq:this.rows.length,hash:last?.hash??''}));}
  assert(id){if(this.blocked||this.rows.some(r=>r.kind==='retire'&&JSON.parse(r.data).oldId===id))throw new Error(this.blocked?'BLOCKED_CONTROL_HISTORY':'SESSION_RETIRED');}
  retired(id){return this.rows.some(r=>r.kind==='retire'&&JSON.parse(r.data).oldId===id);}
  async prepare(id,kind,data){
    const row=this.appendSync(id,kind,data);try{await this.anchor();}catch{this.blocked=true;throw new Error('CONTROL_ANCHOR_FAILED');}return row;
  }
  applied(id){this.db.prepare("UPDATE instruction SET phase='applied' WHERE id=?").run(id);this.reload();}
  status(){return {knowledgeStoreId:this.id,keyBackend:'Windows DPAPI',controlSeq:this.rows.length,verified:!this.blocked,rollbackDetection:'business rollback detected; whole independent safety store rollback needs an external anchor'};}
  close(){this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db?.close();}
}
export class GuardedJsonl extends Jsonl {
  static Config=undefined;
  constructor(ctx,config){
    const nativeRoot=config.root??path.join(process.env.DSH_HOME,'sessions');super(ctx,{root:nativeRoot,...(config.compression?{compression:config.compression}:{})});
    this.nativeRoot=path.resolve(nativeRoot);this.safetyRoot=path.resolve(config.safetyRoot??path.join(process.env.DSH_HOME,'become-human-safety'));this.handles=new Set();
    this.ready=this.initialize();ctx.effect(()=>async()=>{try{await this.ready;}catch{}for(const h of [...this.handles])await h.close().catch(()=>{});this.ledger?.close();await new Promise(resolve=>this.lock?this.lock.close(resolve):resolve());},'becomeHuman.guardedStorage');
  }
  async initialize(){
    const parent=path.dirname(this.nativeRoot);await fs.mkdir(parent,{recursive:true});if(await fs.realpath(parent)!==parent)throw new Error('LINKED_STORAGE_ROOT');
    const port=25000+Number.parseInt(createHash('sha256').update(this.nativeRoot.toLowerCase()).digest('hex').slice(0,6),16)%20000;
    this.lock=net.createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{this.lock.once('error',()=>reject(new Error('KNOWLEDGE_STORE_ALREADY_OWNED')));this.lock.listen({port,host:'127.0.0.1',exclusive:true},resolve);});
    try{this.ledger=await SafetyLedger.open(this.safetyRoot);}catch(e){await new Promise(resolve=>this.lock.close(resolve));this.lock=null;throw e;}
  }
  guard(id){this.ledger.assert(id);}
  async create(header,options){await this.ready;this.guard(header.id);if(header.parentSession){this.guard(header.parentSession);throw new Error('FORK_DISABLED_P0');}return this.wrap(await super.create(header,options));}
  async open(id,access,options){await this.ready;this.guard(id);const handle=await super.open(id,access,options);try{this.guard(id);}catch(e){await handle.close();throw e;}return this.wrap(handle);}
  wrap(native){
    const storage=this,wrapped={id:native.id,header:native.header,access:native.access,inheritedEventCount:native.inheritedEventCount,
      async read(...args){storage.guard(native.id);const value=await native.read(...args);storage.guard(native.id);return value;},
      async append(...args){storage.guard(native.id);return native.append(...args);},
      async flush(...args){storage.guard(native.id);return native.flush(...args);},
      async close(){await native.close();storage.handles.delete(wrapped);}};this.handles.add(wrapped);return wrapped;
  }
  async stat(id,options){await this.ready;if(this.ledger.retired(id))return undefined;return super.stat(id,options);}
  async list(options){await this.ready;return (await super.list(options)).filter(s=>!this.ledger.retired(s.header.id));}
  async resolveCurrentLog(id,signal){await this.ready;this.guard(id);return super.resolveCurrentLog(id,signal);}
  async rawCurrent(id){await this.ready;return super.resolveCurrentLog(id);}
  async rawLease(id){await this.ready;return super.open(id,'write');}
  persistBatch(header,...args){this.guard(header.id);return super.persistBatch(header,...args);}
  persistHeader(header,...args){this.guard(header.id);return super.persistHeader(header,...args);}
  async revokeReaders(id){for(const handle of [...this.handles].filter(h=>h.id===id)){if(handle.access==='write')throw new Error('LIVE_WRITER_NOT_DRAINED');await handle.close();}}
}
export const name='become-human-storage';
export function apply(ctx,config){ctx.plugin(GuardedJsonl,config);}
