import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR;
const hook=anchor?registerHooks({resolve(name,context,next){try{return next(name,context);}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.startsWith('/')||name.includes(':'))throw error;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}}):null;
const {ControlJournal}=await import('../plugins/become-human/driver.mjs');
const {DomainMemory}=await import('../plugins/become-human/domain.mjs');
const {GuardedJsonl}=await import('../plugins/become-human/safety.mjs');
const {SessionRetirement}=await import('../plugins/become-human/retirement.mjs');
const {Context}=await import('@deepseek-ai/cordis');
const {Session}=await import('@deepseek-ai/dsh-session');
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'bh-export-race-')),cases=[];
async function fixture(){
 const local=path.join(root,randomUUID()),dataRoot=path.join(local,'data');await fs.mkdir(dataRoot,{recursive:true});const ctx=new Context(),fiber=await ctx.plugin(GuardedJsonl,{root:path.join(local,'native'),safetyRoot:path.join(local,'safety'),compression:'none'});await ctx.sessionPersistence.ready;
 const storage=ctx.sessionPersistence,journal=new ControlJournal(path.join(local,'journal.sqlite')),domain=new DomainMemory(journal),id=randomUUID();journal.ensure(id);journal.safety=storage.ledger;await storage.ledger.configureBudget('synthetic-export',10000,23);const retirement=new SessionRetirement(storage,journal,domain,{dataRoot});
 const session=Session.create(id);session.append('user/message',{id:randomUUID(),role:'user',source:{kind:'export-concurrency-fixture'},content:[{type:'text',text:'SYNTHETIC_EXPORT_CONCURRENCY_BODY'}]},{surfaceOp:'append'});const writer=await storage.create(session.header);await writer.append(session.snapshotEvents());await writer.flush();await writer.close();
 return {local,dataRoot,storage,journal,domain,retirement,id,async erase(){const preview=await retirement.preview(id),requestId=randomUUID();await retirement.request({id,token:preview.token,confirmation:'删除当前会话',requestId});await retirement.jobs.get(requestId).promise;assert.equal(retirement.status(requestId).phase,'completed');},async close(){await retirement.close();journal.close();await fiber.dispose();}};
}
async function test(name,body){let f;try{f=await fixture();const evidence=await body(f);cases.push({name,passed:true,evidence});}catch(error){cases.push({name,passed:false,error:error.stack});}finally{await f?.close();}console.log(JSON.stringify(cases.at(-1)));}
await test('normal-export-has-matching-receipt-and-is-retired-with-session',async f=>{const result=await f.retirement.export(f.id),bytes=await fs.readFile(result.file),body=JSON.parse(bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),result.hash);assert.equal(body.events.filter(event=>event.type==='user/message').length,1);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,1);await f.erase();await assert.rejects(fs.stat(result.file),error=>error.code==='ENOENT');return {receiptMatches:true,nativeEventPreserved:true,managedExportRetired:true};});
for(const point of ['before-register','before-open','after-open'])await test('retirement-during-export-'+point,async f=>{
 const reached=Promise.withResolvers(),release=Promise.withResolvers(),originalOpen=fs.open,originalChecked=f.retirement.checked.bind(f.retirement);let intercepted=false;
 const match=file=>String(file).startsWith(path.join(f.dataRoot,'exports')+path.sep);
 if(point==='before-register')f.retirement.checked=async(file,...args)=>{const result=await originalChecked(file,...args);if(match(file)&&!intercepted){intercepted=true;reached.resolve();await release.promise;}return result;};
 else fs.open=async(file,...args)=>{if(match(file)&&args[0]==='wx'&&!intercepted){intercepted=true;const handle=point==='after-open'?await originalOpen(file,...args):null;reached.resolve();await release.promise;return handle??originalOpen(file,...args);}return originalOpen(file,...args);};
 const exported=f.retirement.export(f.id).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}));
 try{const timer=setTimeout(()=>reached.reject(Error('EXPORT_BARRIER_TIMEOUT')),10000);try{await reached.promise;}finally{clearTimeout(timer);}await f.erase();release.resolve();const result=await exported;assert.equal(result.ok,false);assert.equal(result.error,'SESSION_RETIRED');const files=await fs.readdir(path.join(f.dataRoot,'exports'));assert.deepEqual(files,[]);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,0);assert.equal(f.storage.ledger.used(),23);await assert.rejects(f.storage.open(f.id,'read'),/SESSION_RETIRED/);return {exportRejected:true,files:0,artifactRows:0,budgetPreserved:23,nativeReadFenced:true};}
 finally{release.resolve();fs.open=originalOpen;f.retirement.checked=originalChecked;await exported;}
});
await test('export-write-error-removes-partial-file-and-registration',async f=>{
 const original=fs.open;let intercepted=false;fs.open=async(file,...args)=>{const handle=await original(file,...args);if(String(file).startsWith(path.join(f.dataRoot,'exports')+path.sep)&&args[0]==='wx'){intercepted=true;handle.writeFile=async()=>{throw Error('SYNTHETIC_WRITE_ERROR');};}return handle;};
 try{await assert.rejects(f.retirement.export(f.id),/SYNTHETIC_WRITE_ERROR/);assert(intercepted);assert.deepEqual(await fs.readdir(path.join(f.dataRoot,'exports')),[]);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,0);assert.equal(f.storage.ledger.retired(f.id),false);return {failedExportCleaned:true,liveSessionRetained:true};}finally{fs.open=original;}
});
await test('oversized-export-does-not-register-an-artifact',async f=>{
 f.domain.list=()=>[{payload:'x'.repeat(2*1024*1024)}];await assert.rejects(f.retirement.export(f.id),/EXPORT_TOO_LARGE/);assert.deepEqual(await fs.readdir(path.join(f.dataRoot,'exports')),[]);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,0);return {oversizedRejected:true,artifactRows:0,files:0};
});
await test('cleanup-denial-retains-ownership-for-retirement',async f=>{
 const originalOpen=fs.open,originalUnlink=fs.unlink;let target;fs.open=async(file,...args)=>{const handle=await originalOpen(file,...args);if(String(file).startsWith(path.join(f.dataRoot,'exports')+path.sep)&&args[0]==='wx'){target=String(file);handle.writeFile=async()=>{throw Error('SYNTHETIC_WRITE_ERROR');};}return handle;};fs.unlink=async file=>{if(String(file)===target)throw Object.assign(Error('SYNTHETIC_CLEANUP_DENIED'),{code:'EACCES'});return originalUnlink(file);};
 try{await assert.rejects(f.retirement.export(f.id),/EXPORT_CLEANUP_PENDING/);assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,1);assert((await fs.stat(target)).isFile());}finally{fs.open=originalOpen;fs.unlink=originalUnlink;}
 await f.erase();await assert.rejects(fs.stat(target),error=>error.code==='ENOENT');return {ownershipRetainedUntilCleanup:true,retirementRemovedFile:true};
});
await test('exclusive-create-conflict-keeps-pre-existing-file',async f=>{
 const original=fs.open;let target;fs.open=async(file,...args)=>{if(String(file).startsWith(path.join(f.dataRoot,'exports')+path.sep)&&args[0]==='wx'){target=String(file);const handle=await original(file,'wx');await handle.writeFile('UNRELATED_SYNTHETIC_COLLISION');await handle.close();}return original(file,...args);};
 try{await assert.rejects(f.retirement.export(f.id),error=>error.code==='EEXIST');assert.equal(await fs.readFile(target,'utf8'),'UNRELATED_SYNTHETIC_COLLISION');assert.equal(f.journal.db.prepare('SELECT count(*) n FROM owned_artifact WHERE agent=?').get(f.id).n,0);return {exclusiveCreateRefused:true,preExistingFilePreserved:true};}finally{fs.open=original;}
});
const result={at:new Date().toISOString(),root,scope:'Maintained export/retirement with real isolated native JSONL, SQLite and DPAPI signed ledger. Deterministic asynchronous race/write-error injection; no OS kill, power loss, production access or model calls.',passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases};await fs.writeFile(process.env.BH_TEST_RESULT??path.join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,passed:result.passed,failed:result.failed}));hook?.deregister();if(result.failed)process.exitCode=1;
