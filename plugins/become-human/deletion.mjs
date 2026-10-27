import {workObservationTableNames} from './work-observation.mjs';
// Owned, disposable deletion laboratory. No real conversation IDs are accepted.
// This is a bounded native-JSONL integration, not an erasure adapter for all DSH plugins.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import {Session} from '@deepseek-ai/dsh-session';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const developmentTables=[...workObservationTableNames,'human_memory_overlay','human_memory_batch','human_memory_summary','human_memory_lifecycle_audit','human_persona_development_state','human_persona_development_review','human_persona_development_change'];
export class DeletionLab {
  constructor(root,journal){
    this.root=path.resolve(root);this.journal=journal;this.ctx=new Context();this.previews=new Map();
    journal.db.exec(`CREATE TABLE IF NOT EXISTS deletion_fixture(id TEXT PRIMARY KEY,root TEXT,state TEXT);
      CREATE TABLE IF NOT EXISTS managed_artifact(agent TEXT,path TEXT,kind TEXT,PRIMARY KEY(agent,path));`);
  }
  async init(){await fs.mkdir(this.root,{recursive:true});this.fiber=await this.ctx.plugin(Jsonl,{root:path.join(this.root,'sessions'),compression:'none'});try{await this.recover();}catch{this.lastError='DELETE_RECOVERY_BLOCKED';}return this;}
  fixture(id){const row=this.journal.db.prepare('SELECT * FROM deletion_fixture WHERE id=?').get(id);if(!row||!/^human-delete-fixture-[a-f0-9-]{36}$/.test(id))throw new Error('NOT_DISPOSABLE_FIXTURE');return row;}
  gate(id){this.fixture(id);this.journal.assertAdmitted(id);}
  async checked(file,{missing=false}={}){
    const target=path.resolve(file),relative=path.relative(this.root,target);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('ARTIFACT_OUTSIDE_ROOT');
    if(await fs.realpath(this.root)!==this.root)throw new Error('LINKED_ROOT');
    let cursor=this.root;
    for(const part of relative.split(path.sep)){
      cursor=path.join(cursor,part);
      try{const stat=await fs.lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw new Error('LINKED_ARTIFACT');}
      catch(e){if(missing&&e.code==='ENOENT')break;throw e;}
    }
    return target;
  }
  async files(dir){
    await this.checked(dir,{missing:true});let entries;
    try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const files=[];
    for(const entry of entries){
      const file=await this.checked(path.join(dir,entry.name));
      if(entry.isDirectory())files.push(...await this.files(file));
      else if(entry.isFile())files.push(file);else throw new Error('UNSUPPORTED_ARTIFACT');
    }
    return files;
  }
  async create(){
    if(this.journal.db.prepare("SELECT 1 FROM retirement r JOIN deletion_fixture f ON f.id=r.id WHERE r.phase!='DONE'").get())throw new Error('DELETE_PENDING');
    // At most one open disposable fixture. No user-supplied fixture body or path.
    const prior=this.journal.db.prepare("SELECT id FROM deletion_fixture WHERE state IN ('active','creating') LIMIT 1").get();if(prior)return this.preview(prior.id);
    const id='human-delete-fixture-'+crypto.randomUUID(),sentinel='DELETE_LAB_'+crypto.randomUUID();
    const dir=path.join(this.root,'copies',id);await fs.mkdir(dir,{recursive:true});
    this.journal.ensure(id);
    this.journal.db.prepare("INSERT INTO deletion_fixture VALUES(?,?,'creating')").run(id,dir);
    const session=Session.create(id);
    session.append('user/message',{id:crypto.randomUUID(),role:'user',source:{kind:'deletion-lab'},content:[{type:'text',text:sentinel}]},{surfaceOp:'append'});
    const writer=await this.ctx.sessionPersistence.create(session.header);await writer.append(session.snapshotEvents());await writer.flush();await writer.close();
    const current=await this.ctx.sessionPersistence.resolveCurrentLog(id);
    this.journal.db.prepare('INSERT INTO managed_artifact VALUES(?,?,?)').run(id,path.dirname(current),'native-session-directory');
    for(const kind of ['export','cache','backup']){const file=path.join(dir,kind+'.json');await fs.writeFile(file,JSON.stringify({id,body:sentinel}));this.journal.db.prepare('INSERT INTO managed_artifact VALUES(?,?,?)').run(id,file,kind);}
    this.journal.put(id,'memory',sentinel);this.journal.publish(id,sentinel,'user','fixture:'+id);
    this.journal.db.prepare("INSERT INTO user_request VALUES(?,?,?,?, 'committed')").run(id,crypto.randomUUID(),sentinel,crypto.randomUUID());
    this.journal.db.prepare("UPDATE deletion_fixture SET state='active' WHERE id=?").run(id);
    return this.preview(id);
  }
  async inventory(id){
    const fixture=this.fixture(id),rows=this.journal.db.prepare('SELECT * FROM managed_artifact WHERE agent=? ORDER BY path').all(id),files=[];
    const current=await this.ctx.sessionPersistence.resolveCurrentLog(id);
    const roots=new Set(rows.map(r=>r.path));
    if(current&&!roots.has(path.dirname(current)))rows.push({path:path.dirname(current),kind:'native-session-directory'});
    if(!roots.has(fixture.root))rows.push({path:fixture.root,kind:'owned-copies-directory'});
    const seen=new Set();
    for(const row of rows){
      const file=await this.checked(row.path,{missing:true});let stat;try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      for(const item of stat.isDirectory()?await this.files(file):[file]){
        // Lock files carry no conversation content and must remain while a native lease is held.
        if(path.basename(item)==='session.lock'||seen.has(item))continue;seen.add(item);
        const bytes=await fs.readFile(item);files.push({path:item,size:bytes.length,hash:hash(bytes),kind:row.kind});
      }
    }
    return files.sort((a,b)=>a.path.localeCompare(b.path));
  }
  async preview(id){
    this.gate(id);const files=await this.inventory(id),token=crypto.randomUUID();
    this.previews.clear();this.previews.set(token,{id,files,expires:Date.now()+120000});
    return {id,token,expires:Date.now()+120000,scope:'disposable-fixture-only',files:files.map(f=>({name:path.basename(f.path),kind:f.kind,bytes:f.size})),sqliteTables:['metadata','outbox','user_request','attempt','response_stage','reservation','audit','control',...developmentTables.filter(table=>this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))],confirmation:'删除临时会话'};
  }
  async request({id,token,confirmation},checkpoint){
    this.fixture(id);const prior=this.journal.db.prepare('SELECT * FROM retirement WHERE id=?').get(id);
    if(prior){await this.recover(checkpoint);return this.status();}
    const preview=this.previews.get(token);
    if(!preview||preview.id!==id||preview.expires<Date.now()||confirmation!=='删除临时会话')throw new Error('INVALID_DELETE_CONFIRMATION');
    if(JSON.stringify(await this.inventory(id))!==JSON.stringify(preview.files))throw new Error('DELETE_PREVIEW_STALE');
    this.journal.transaction(()=>{
      this.journal.db.prepare("INSERT INTO retirement VALUES(?,'PREPARED',?,?)").run(id,JSON.stringify(preview.files.map(f=>f.path)),Date.now());
      this.journal.db.prepare("UPDATE deletion_fixture SET state='retiring' WHERE id=?").run(id);
    });this.previews.delete(token);await checkpoint?.('after-intent');await this.recover(checkpoint);return this.status();
  }
  async recover(checkpoint){
    for(const job of this.journal.db.prepare('SELECT r.* FROM retirement r JOIN deletion_fixture f ON f.id=r.id').all()){
      const row=this.fixture(job.id);let lease;
      try{
        // Also recheck DONE jobs: an externally restored old body must not reappear through the managed adapter.
        const current=await this.ctx.sessionPersistence.resolveCurrentLog(job.id);
        if(current)lease=await this.ctx.sessionPersistence.open(job.id,'write',{signal:AbortSignal.timeout(1000)});
        const files=new Set([...JSON.parse(job.manifest),...(await this.inventory(job.id)).map(f=>f.path)]);
        let count=0;
        for(const file of files){
          await this.checked(file,{missing:true});try{const stat=await fs.lstat(file);if(!stat.isFile())throw new Error('UNSUPPORTED_ARTIFACT');await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
          if(++count===1)await checkpoint?.('during-purge');
        }
        this.journal.transaction(()=>{
          for(const table of developmentTables)if(this.journal.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))this.journal.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(job.id);
          for(const table of ['metadata','outbox','user_request','attempt','response_stage','reservation','audit'])this.journal.db.prepare('DELETE FROM '+table+' WHERE agent=?').run(job.id);
          this.journal.db.prepare('DELETE FROM control WHERE id=?').run(job.id);
          this.journal.db.prepare("UPDATE retirement SET phase='PURGED' WHERE id=?").run(job.id);
        });
        this.journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE);VACUUM;PRAGMA wal_checkpoint(TRUNCATE)');
        await checkpoint?.('after-purge');
        this.journal.transaction(()=>{this.journal.db.prepare("UPDATE retirement SET phase='DONE' WHERE id=?").run(job.id);this.journal.db.prepare("UPDATE deletion_fixture SET state='retired' WHERE id=?").run(job.id);});
      }finally{await lease?.close();}
      // Keep the registry and content-free tombstone to fence restore. Never retain body backups.
      await this.checked(row.root,{missing:true});
    }
    this.lastError=null;
  }
  async read(id){this.gate(id);const handle=await this.ctx.sessionPersistence.open(id,'read');try{const value=await handle.read();this.gate(id);return value;}finally{await handle.close();}}
  status(){return {scope:'disposable-fixture-only',lastError:this.lastError??null,fixtures:this.journal.db.prepare('SELECT id,state FROM deletion_fixture ORDER BY rowid DESC LIMIT 5').all(),retirements:this.journal.db.prepare('SELECT r.id,r.phase FROM retirement r JOIN deletion_fixture f ON f.id=r.id ORDER BY r.created DESC LIMIT 5').all(),realConversationDeletion:{enabled:false,reason:'真实会话删除需要补齐分叉、导出等副本的追踪'}};}
  async close(){await this.fiber?.dispose();}
}
