import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';import {registerHooks} from 'node:module';import {pathToFileURL,fileURLToPath} from 'node:url';
const mode=process.argv[2];
if(mode){
 const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');registerHooks({resolve(name,ctx,next){try{return next(name,ctx);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...ctx,parentURL:pathToFileURL(anchor).href});}}});
 const {ControlJournal}=await import('../plugins/become-human/driver.mjs'),{DomainMemory}=await import('../plugins/become-human/domain.mjs'),{AutonomyStore}=await import('../plugins/become-human/autonomy-store.mjs'),{ExperienceStore}=await import('../plugins/become-human/experience.mjs'),{drainActivityFeedback}=await import('../plugins/become-human/activity-feedback.mjs');
 const [dir,id]=process.argv.slice(3),journal=new ControlJournal(path.join(dir,'state.sqlite'));journal.ensure(id);const domain=new DomainMemory(journal),autonomy=new AutonomyStore(journal,domain),experience=new ExperienceStore(journal,domain),f={journal,domain,autonomy,experience};domain.experience=experience;
 if(mode==='write'){
  const task=autonomy.task(id,'behavior',{behaviorId:'crash-proof',plan:{question:'【开发测试】检查进程恢复',value:'验证本地反馈'},behaviorResult:{status:'completed',summary:'已完成合成动作'}},1);
  await fs.appendFile(path.join(dir,'effects.txt'),'executed\n');autonomy.update(task.id,'completed');
  process.exit(91); // Deliberate ungraceful exit before any feedback, no close.
 }
 const result=drainActivityFeedback(f,id),count=journal.db.prepare('SELECT count(*) n FROM human_experience WHERE agent=?').get(id).n;
 assert.equal((await fs.readFile(path.join(dir,'effects.txt'),'utf8')).trim(),'executed');assert.equal(count,1);assert.equal(experience.recent(id).length,0);assert.equal(journal.db.prepare('SELECT count(*) n FROM outbox WHERE agent=?').get(id).n,0);journal.close();console.log(JSON.stringify({...result,experiences:count,externalExecutions:1,realGrowthEvidence:0}));
}else{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'human-feedback-process-')),id=randomUUID(),file=fileURLToPath(import.meta.url),run=mode=>spawnSync(process.execPath,[file,mode,dir,id],{encoding:'utf8',windowsHide:true,timeout:60000});
 const written=run('write');assert.equal(written.status,91,written.stderr);const first=run('recover');assert.equal(first.status,0,first.stderr);const firstResult=JSON.parse(first.stdout);assert.equal(firstResult.completed,1);const second=run('recover');assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).completed,0);
 const result={at:new Date().toISOString(),passed:3,failed:0,checks:['Ungraceful writer exit leaves durable feedback','Fresh process settles once without replaying execution','Second process recovery is idempotent; development evidence excluded'],scope:'Real local child processes, synthetic activity; no model, IM or production state.'};if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
