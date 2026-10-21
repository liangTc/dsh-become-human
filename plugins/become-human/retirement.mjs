import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {actionPaths,readActionFile,sameManagedPair} from './actions-files.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class SessionRetirement {
  constructor(storage,journal,domain,{dataRoot,quiesce=async()=>{},replace=async()=>{}}){this.storage=storage;this.journal=journal;this.domain=domain;this.dataRoot=path.resolve(dataRoot);this.quiesce=quiesce;this.replace=replace;this.previews=new Map();this.jobs=new Map();journal.db.exec('CREATE TABLE IF NOT EXISTS owned_artifact(agent TEXT,path TEXT PRIMARY KEY,kind TEXT)');}
  managedActionPair(file){
    try{
      if(!this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='human_action'").get())return false;
      const row=this.journal.db.prepare("SELECT * FROM human_action WHERE status='completed' AND (path=? OR substr(path,1,length(path)-3)||'.pending'=?)").get(file,file);if(!row)return false;
      const paths=actionPaths(path.join(this.dataRoot,'artifacts'),row.agent,row.id),receipt=JSON.parse(row.receipt??'null');
      if(row.path!==paths.path||![paths.path,paths.stage].includes(file)||!sameManagedPair(paths)||receipt?.path!==row.path||receipt.digest!==row.digest||receipt.bytes!==row.bytes)return false;
      const signed=this.storage.ledger?.rows.some(r=>{if(r.kind!=='human-action-completed')return false;const d=JSON.parse(r.data);return d.agent===row.agent&&d.actionId===row.id&&d.digest===row.digest&&d.bytes===row.bytes&&d.pathHash===hash(Buffer.from(row.path));});if(!signed)return false;
      const actual=readActionFile(paths,{allowPair:true});return actual?.digest===row.digest&&actual.bytes===row.bytes;
    }catch{return false;}
  }
  async checked(file,{missing=false,allowManagedPair=false}={}){
    const target=path.resolve(file),roots=[this.storage.nativeRoot,this.dataRoot],root=roots.find(r=>{const rel=path.relative(r,target);return rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);});if(!root)throw new Error('ARTIFACT_OUTSIDE_ROOT');
    if(await fs.realpath(root)!==root)throw new Error('LINKED_STORAGE_ROOT');let current=root;
    for(const part of path.relative(root,target).split(path.sep)){current=path.join(current,part);try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1&&!(allowManagedPair&&current===target&&stat.nlink===2&&this.managedActionPair(target)))throw new Error('LINKED_ARTIFACT');}catch(e){if(missing&&e.code==='ENOENT')break;throw e;}}return target;
  }
  async files(dir){await this.checked(dir,{missing:true});let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}const out=[];for(const entry of entries){const file=await this.checked(path.join(dir,entry.name));if(entry.isDirectory())out.push(...await this.files(file));else if(entry.isFile()&&entry.name!=='session.lock')out.push(file);else if(!entry.isFile())throw new Error('UNSUPPORTED_ARTIFACT');}return out;}
  async inventory(id){const current=await this.storage.rawCurrent(id),files=new Set(current?await this.files(path.dirname(current)):[]);for(const row of this.journal.db.prepare('SELECT path FROM owned_artifact WHERE agent=?').all(id)){await this.checked(row.path,{missing:true,allowManagedPair:true});try{if((await fs.stat(row.path)).isFile())files.add(row.path);}catch(e){if(e.code!=='ENOENT')throw e;}}const rows=[];for(const file of files){const bytes=await fs.readFile(file);rows.push({path:file,bytes:bytes.length,hash:hash(bytes)});}return rows.sort((a,b)=>a.path.localeCompare(b.path));}
  async preview(id){this.storage.guard(id);const files=await this.inventory(id),token=crypto.randomUUID();const preview={id,token,files,expires:Date.now()+120000,budget:{used:this.journal.get(id)?.used??0,base:this.journal.value(id,'budgetBase',0),round:this.journal.value(id,'budgetRound','legacy')}};this.previews.clear();this.previews.set(token,preview);return {id,token,expires:preview.expires,scope:'whole-current-session',mode:'source',files:files.map(f=>({name:path.basename(f.path),bytes:f.bytes})),includes:['全部原生会话历史','六类记忆和来源','角色版本和目标','输入、调用与投递记录','受管导出包'],retains:['无正文删除墓碑','历史预算占额'],confirmation:'删除当前会话'};}
  async request({id,token,confirmation,requestId}){
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestId))throw new Error('INVALID_REQUEST_ID');
    const prior=this.storage.ledger.rows.find(r=>r.id===requestId);if(prior){const data=JSON.parse(prior.data);if(data.oldId!==id||confirmation!=='删除当前会话')throw new Error('REQUEST_ID_CONFLICT');this.launch(prior);return this.status(prior.id);}
    const preview=this.previews.get(token);if(!preview||preview.id!==id||preview.expires<Date.now()||confirmation!=='删除当前会话')throw new Error('INVALID_DELETE_CONFIRMATION');
    if(JSON.stringify(await this.inventory(id))!==JSON.stringify(preview.files))throw new Error('DELETE_PREVIEW_STALE');
    const data={oldId:id,newId:crypto.randomUUID(),paths:preview.files.map(f=>f.path),budget:preview.budget};
    const row=await this.storage.ledger.prepare(requestId,'retire',data);this.previews.delete(token);this.launch(row);return this.status(row.id);
  }
  launch(row){if(this.jobs.get(row.id)?.promise)return;const state={operationId:row.id,phase:'prepared',error:null};this.jobs.set(row.id,state);state.promise=this.run(row,state).catch(e=>{state.phase='partial';state.error=['LINKED_ARTIFACT','ARTIFACT_OUTSIDE_ROOT'].includes(e.message)?e.message:'CLEANUP_PENDING';}).finally(()=>{state.promise=null;});}
  async run(row,state){
    const data=JSON.parse(row.data);await this.quiesce(data.oldId);await this.storage.revokeReaders(data.oldId);state.phase='purging';let lease;
    try{
      if(await this.storage.rawCurrent(data.oldId))lease=await this.storage.rawLease(data.oldId);
      const files=new Set([...data.paths,...(await this.inventory(data.oldId)).map(f=>f.path)]);
      for(const file of files){await this.checked(file,{missing:true,allowManagedPair:true});try{const stat=await fs.lstat(file);if(!stat.isFile())throw new Error('UNSUPPORTED_ARTIFACT');await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
    }finally{await lease?.close();}
    this.journal.transaction(()=>{
      this.domain.purgeAgent(data.oldId);
      for(const table of ['autonomy_event','autonomy_task','learning_note','reminder','reminder_delivery','human_event','human_memory_revision','human_note_revision','human_skill','human_skill_revision','human_goal_plan','human_action','human_tool_job','human_capability_job','human_page_snapshot'])if(this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))this.journal.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(data.oldId);
      for(const table of ['metadata','outbox','user_request','attempt','response_stage','reservation','audit','owned_artifact'])this.journal.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(data.oldId);
      this.journal.db.prepare('DELETE FROM control WHERE id=?').run(data.oldId);
      this.journal.db.prepare("INSERT OR REPLACE INTO retirement VALUES(?,'DONE',?,?)").run(data.oldId,JSON.stringify(data.paths),Date.now());
      const existed=this.journal.get(data.newId);this.journal.ensure(data.newId);if(!existed){this.journal.db.prepare('UPDATE control SET used=? WHERE id=?').run(this.storage.ledger.budget.round?this.storage.ledger.used():data.budget.used,data.newId);this.journal.put(data.newId,'budgetBase',this.storage.ledger.budget.round?this.storage.ledger.budget.base:data.budget.base);this.journal.put(data.newId,'budgetRound',this.storage.ledger.budget.round??data.budget.round);}
    });
    state.phase='compacting';await this.compact();
    this.storage.ledger.applied(row.id);state.phase='completed';await this.replace(data.oldId,data.newId);
  }
  compact(){return new Promise((resolve,reject)=>{const worker=new Worker(new URL('./storage-maintenance.mjs',import.meta.url),{workerData:{file:this.journal.file}});worker.on('message',result=>result.ok?resolve():reject(new Error('PENDING_COMPACTION')));worker.on('error',reject);worker.on('exit',code=>{if(code!==0)reject(new Error('PENDING_COMPACTION'));});});}
  async recover(){for(const row of this.storage.ledger.rows.filter(r=>r.kind==='retire')){this.launch(row);await this.jobs.get(row.id).promise;if(this.jobs.get(row.id).phase!=='completed')throw new Error('BLOCKED_CONTROL_HISTORY');}}
  status(id){if(id)return this.jobs.get(id)?{operationId:id,phase:this.jobs.get(id).phase,error:this.jobs.get(id).error}:{operationId:id,phase:'completed'};return [...this.jobs.values()].slice(-5).map(s=>({operationId:s.operationId,phase:s.phase,error:s.error}));}
  async export(id){
    this.storage.guard(id);const handle=await this.storage.open(id,'read');let read;try{read=await handle.read();}finally{await handle.close();}this.storage.guard(id);
    const dir=path.join(this.dataRoot,'exports');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,crypto.randomUUID()+'.json');await this.checked(file,{missing:true});
    this.journal.db.prepare('INSERT INTO owned_artifact VALUES(?,?,?)').run(id,file,'export');
    const body=JSON.stringify({header:handle.header,events:read.events,memories:this.domain.list(id,{limit:100})});
    if(Buffer.byteLength(body)>2*1024*1024)throw new Error('EXPORT_TOO_LARGE');
    const fh=await fs.open(file,'wx');try{await fh.writeFile(body);await fh.sync();}finally{await fh.close();}
    try{this.storage.guard(id);}catch(e){await fs.unlink(file).catch(()=>{});throw e;}return {file,id,hash:hash(Buffer.from(body))};
  }
  async close(){await Promise.all([...this.jobs.values()].map(j=>j.promise).filter(Boolean));}
}
