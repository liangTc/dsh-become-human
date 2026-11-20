import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import semver from 'semver';
import {ExtensionRecovery,profileImage,recoveryFile} from './extension-recovery.mjs';
import {HUMAN_PACKAGE,fetchHumanRelease,downloadHumanRelease,digest} from './human-update-runtime.mjs';

const activeStates=new Set(['preparing','installing','verifying','recovering']);
const heldStates=new Set(['installing','verifying','restart-required','rollback-restart-required','interrupted','recovering','recovery-required']);
const idOk=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{16,80}$/.test(x);
const fail=code=>{throw Error(code);};
const code=e=>/^UPDATE_[A-Z_]+$/.test(e?.message??'')?e.message:'UPDATE_OPERATION_FAILED';
async function atomic(file,value){await recoveryFile(file);const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}

/** Updates the manager package only. Runtime files come from that same package
 * on the next host boot. No session, memory, credential or binding is replaced. */
export class HumanUpdater {
 constructor({root,adapter,runtime,remote,runningVersion,dshVersion,fetchImpl=fetch,now=Date.now,download=downloadHumanRelease}){
  this.root=path.join(root,'updates');this.file=path.join(this.root,'state.json');this.lock=path.join(this.root,'install.lock');
  Object.assign(this,{adapter,runtime,remote,runningVersion,dshVersion,fetchImpl,now,download});this.queue=Promise.resolve();this.active=null;this.closed=false;
 }
 async init(){
  await fs.mkdir(this.root,{recursive:true,mode:0o700});const s=await fs.lstat(this.root);if(s.isSymbolicLink()||!s.isDirectory())fail('UPDATE_STATE_UNAVAILABLE');
  this.job=JSON.parse(await recoveryFile(this.file)??'null');const lock=JSON.parse(await recoveryFile(this.lock)??'null');
  if(this.job&&(!/^[a-f0-9-]{36}$/.test(this.job.id)||!semver.valid(this.job.targetVersion)))fail('UPDATE_STATE_UNAVAILABLE');
  if(lock&&alive(lock.pid)&&lock.pid!==process.pid)fail('UPDATE_BUSY');
  if(this.job&&activeStates.has(this.job.state)){this.job.state=this.job.recovery?'interrupted':'failed';this.job.error='UPDATE_INTERRUPTED';await this.save();}
  // Before the job is durable no package mutation can start. A stale prepare
  // lock is safe to release, unlike a lock accompanying an install snapshot.
  if(lock&&(!this.job||this.job.state==='failed'&&!this.job.recovery)){await fs.unlink(this.lock);}
  if(this.blocksRuntime)this.remote.maintenance=true;
  return this;
 }
 get blocksRuntime(){return heldStates.has(this.job?.state);}
 get busy(){return !!this.active;}
 get recovery(){return new ExtensionRecovery(this.root,this.adapter.profile);}
 async save(){await atomic(this.file,this.job);}
 async unlock(){const lock=JSON.parse(await recoveryFile(this.lock)??'null');if(lock?.id===this.job?.id)await fs.unlink(this.lock);}
 bindingDigest(){return digest(JSON.stringify(this.remote.db.prepare('SELECT id,kind,config,enabled,session FROM channel ORDER BY id').all()));}
 async status(){
  const environment=await this.adapter.inspect(),checked=this.checked;
  const blockedReason=this.blocksRuntime?'UPDATE_RESTART_OR_RECOVERY_REQUIRED':environment.blockedReason??checked?.release.blockedReason??null;
  const canInstall=!this.closed&&!this.busy&&!blockedReason&&checked?.identity===environment.identity&&this.now()<checked.expires&&semver.gt(checked.release.version,this.runningVersion);
  const job=this.job?Object.fromEntries(['id','state','targetVersion','previousVersion','startedAt','finishedAt','error','recoveryError'].filter(k=>this.job[k]!==undefined).map(k=>[k,this.job[k]])):null;
  return {runningVersion:this.runningVersion,installedVersion:environment.installedVersion,profileName:environment.profileName,latestVersion:checked?.release.version??null,channel:checked?.release.channel??(semver.prerelease(this.runningVersion)?'beta':'latest'),checkedAt:checked?.at??null,blockedReason,canInstall:Boolean(canInstall),checkId:canInstall?checked.id:null,busy:this.busy,job,canRecover:!!this.job?.recovery&&['restart-required','interrupted','recovery-required'].includes(this.job.state)&&!this.busy&&!this.job.manualRecovery};
 }
 async check(channel){
  if(this.closed)fail('UPDATE_CLOSED');if(this.busy)fail('UPDATE_BUSY');
  this.checked=null;
  const environment=await this.adapter.inspect();
  if(environment.blockedReason==='UPDATE_DESKTOP_HOST_MANAGED')return this.status();
  const release=await fetchHumanRelease(channel,{fetchImpl:this.fetchImpl,dshVersion:this.dshVersion});
  this.checked={id:randomUUID(),at:this.now(),expires:this.now()+600000,identity:environment.identity,release};return this.status();
 }
 submit(input){const op=this.queue.catch(()=>{}).then(()=>this.admit(input));this.queue=op;return op;}
 async admit(input){
  if(this.closed)fail('UPDATE_CLOSED');
  if(!idOk(input.requestId)||!['install','recover'].includes(input.action))fail('UPDATE_REQUEST_INVALID');
  const requestHash=digest(JSON.stringify({action:input.action,checkId:input.checkId??null,jobId:input.jobId??null}));
  if(this.job?.requestId===input.requestId){if(this.job.requestHash!==requestHash)fail('UPDATE_REQUEST_CONFLICT');return this.status();}
  if(this.job?.recoverRequestId===input.requestId){if(this.job.recoverRequestHash!==requestHash)fail('UPDATE_REQUEST_CONFLICT');return this.status();}
  if(this.busy)fail('UPDATE_BUSY');
  const environment=await this.adapter.inspect();
  if(environment.blockedReason==='UPDATE_DESKTOP_HOST_MANAGED')fail(environment.blockedReason);
  if(input.action==='recover'){
   if(input.jobId!==this.job?.id||!(await this.status()).canRecover)fail('UPDATE_RECOVERY_UNAVAILABLE');
   if(environment.blockedReason&&environment.blockedReason!=='UPDATE_INSTALLATION_CHANGED')fail(environment.blockedReason);
   this.job.recoverRequestId=input.requestId;this.job.recoverRequestHash=requestHash;this.job.state='recovering';this.job.error=null;await this.save();this.remote.maintenance=true;
   this.launch(()=>this.recover());return this.status();
  }
  const checked=this.checked;
  if(!checked||input.checkId!==checked.id||this.now()>=checked.expires)fail('UPDATE_CHECK_EXPIRED');
  if(environment.identity!==checked.identity)fail('UPDATE_INSTALLATION_CHANGED');
  if(!(await this.status()).canInstall)fail(environment.blockedReason??checked.release.blockedReason??'UPDATE_NOT_NEWER');
  if(input.confirm!==true)fail('UPDATE_CONFIRM_REQUIRED');
  const id=randomUUID();
  // A leftover lock is never silently discarded; inspect/recover the prior job.
  const lock=await fs.open(this.lock,'wx',0o600).catch(e=>{if(e.code==='EEXIST')fail('UPDATE_RECOVERY_UNAVAILABLE');throw e;});
  try{await lock.writeFile(JSON.stringify({id,pid:process.pid}));}finally{await lock.close();}
  this.job={id,requestId:input.requestId,requestHash,state:'preparing',targetVersion:checked.release.version,previousVersion:environment.installedVersion,startedAt:this.now(),error:null};
  try{await this.save();}catch(e){await this.unlock();throw e;}
  this.launch(()=>this.execute(checked,environment));return this.status();
 }
 launch(work){
  this.controller=new AbortController();this.active=work().catch(async e=>{this.job.state=this.job.recovery?'recovery-required':'failed';this.job.error=code(e);await this.save().catch(()=>{});}).finally(()=>{this.active=null;});
 }
 async execute(checked,environment){
  const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(15*60*1000)]),file=path.join(this.root,this.job.id+'.tgz');let stopped=false;
  try{
   const release=await fetchHumanRelease(checked.release.channel,{fetchImpl:this.fetchImpl,dshVersion:this.dshVersion});
   if(JSON.stringify(release)!==JSON.stringify(checked.release))fail('UPDATE_CHECK_EXPIRED');
   this.job.archive=await this.download(release,file,{fetchImpl:this.fetchImpl,signal});signal.throwIfAborted();
   if((await this.adapter.inspect()).identity!==environment.identity)fail('UPDATE_INSTALLATION_CHANGED');
   let before;
   try{before=await this.runtime.state();}catch{
    // An unavailable worker must not prevent installing its repair. Preserve
    // its on-disk identity, but never infer permission to resume after failure.
    const home=this.runtime.config?.runtimeHome;
    if(!home||!path.isAbsolute(home))fail('UPDATE_RUNTIME_NOT_READY');
    const identity=JSON.parse(await recoveryFile(path.join(home,'become-human','agent.json'))??'null');
    before={sessionId:identity?.sessionId,desired:'paused'};
   }
   if(!before.sessionId||before.retiring)fail('UPDATE_RUNTIME_NOT_READY');
   this.job.original={sessionId:before.sessionId,desired:before.desired,replyEnabled:this.remote.preference('reply-enabled'),bindingDigest:this.bindingDigest()};
   this.job.recovery=await this.recovery.capture(this.job.id,{packages:true,sessionId:before.sessionId});
   this.job.state='installing';await this.save();this.remote.maintenance=true;
   await this.remote.stopRuntime();stopped=true;signal.throwIfAborted();
   if((await this.adapter.inspect()).identity!==environment.identity)fail('UPDATE_INSTALLATION_CHANGED');
   this.job.installStarted=true;await this.save();await this.adapter.install(file,signal);signal.throwIfAborted();this.job.state='verifying';await this.save();
   const installed=await this.adapter.inspect();if(installed.installedVersion!==release.version||installed.blockedReason)fail('UPDATE_VERIFY_FAILED');
   const baseline=await this.recovery.load(this.job),after=await profileImage(this.adapter.profile),oldManifest=JSON.parse(baseline.files['package.json']),newManifest=JSON.parse(after.files['package.json']);
   for(const [key,value] of Object.entries(oldManifest.dependencies??{}))if(key!==HUMAN_PACKAGE&&newManifest.dependencies?.[key]!==value)fail('UPDATE_OTHER_PLUGIN_CHANGED');
   for(const [name,version] of Object.entries(baseline.installed))if(name!==HUMAN_PACKAGE&&JSON.parse(await recoveryFile(path.join(this.adapter.profile,'node_modules',name,'package.json'))).version!==version)fail('UPDATE_OTHER_PLUGIN_CHANGED');
   for(const key of ['cordis.patch.yml','human-extensions.patch.yml'])if(baseline.files[key]!==after.files[key])fail('UPDATE_CONFIGURATION_CHANGED');
   const original=this.job.original;if(this.bindingDigest()!==original.bindingDigest)fail('UPDATE_BINDING_CHANGED');
   signal.throwIfAborted();this.job.recovery.after=after.digest;this.job.recovery.status='prepared';this.job.state='restart-required';this.job.finishedAt=this.now();await this.save();await this.unlock();
  }catch(e){
   this.job.state=this.job.recovery?'recovery-required':'failed';this.job.error=signal.aborted?'UPDATE_INTERRUPTED':code(e);
   if(this.job.recovery){if(e.message==='UPDATE_INSTALLATION_CHANGED'&&!this.job.installStarted)this.job.manualRecovery=true;else this.job.recovery.after=(await profileImage(this.adapter.profile)).digest;}
   await this.save();await this.unlock();
   if(!stopped&&!this.job.recovery)this.remote.maintenance=false;
  }finally{if(!this.job.installStarted)await fs.unlink(file).catch(()=>{});}
 }
 async recover(){
  const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(15*60*1000)]);
  try{
   const snapshot=await this.recovery.load(this.job);
   if(!this.job.recovery.after||(await profileImage(this.adapter.profile)).digest!==this.job.recovery.after)fail('UPDATE_RECOVERY_CONFLICT');
   await this.remote.stopRuntime();await this.recovery.restoreFiles(snapshot);
   // An interrupted restore must retain the exact point at which it stopped.
   this.job.recovery.after=(await profileImage(this.adapter.profile)).digest;await this.save();
   await this.adapter.restore(signal);await this.recovery.verifyPackages(snapshot);await this.recovery.restoreFiles(snapshot);
   if((await profileImage(this.adapter.profile)).digest!==snapshot.digest)fail('UPDATE_VERIFY_FAILED');
   this.job.recovery.status='restored';this.job.state=this.runningVersion===this.job.previousVersion?'restored':'rollback-restart-required';this.job.error=null;this.job.recoveryError=null;this.job.finishedAt=this.now();await this.save();await this.unlock();
   if(this.job.state==='rollback-restart-required')return;
   signal.throwIfAborted();this.remote.maintenance=false;this.runtime.closed=false;await this.runtime.start();signal.throwIfAborted();await this.restoreRunState();
  }catch(e){this.remote.maintenance=true;await this.remote.stopRuntime().catch(()=>{});this.job.state='recovery-required';this.job.recoveryError=code(e);if(e.message==='UPDATE_RECOVERY_CONFLICT')this.job.manualRecovery=true;else this.job.recovery.after=(await profileImage(this.adapter.profile)).digest;await this.save();}
 }
 async restoreRunState(){
  if(this.closed)fail('UPDATE_CLOSED');
  const current=await this.runtime.state(),original=this.job.original;
  if(current.sessionId!==original.sessionId||this.bindingDigest()!==original.bindingDigest)fail('UPDATE_IDENTITY_CHANGED');
  // Preserve protective pauses. Never retry a failed task or clear autonomy errors.
  if(original.desired==='running'&&!current.lastError&&!current.autonomy?.error&&!current.autonomy?.paused&&current.desired==='paused')await this.remote.controlRuntime({op:'start',sessionId:current.sessionId,expectedEpoch:current.cancelEpoch});
 }
 async readyToBoot(){
  if(!['restart-required','rollback-restart-required'].includes(this.job?.state))return !this.blocksRuntime;
  const environment=await this.adapter.inspect();
  const target=this.job.state==='rollback-restart-required'?this.job.previousVersion:this.job.targetVersion,expected=this.job.state==='rollback-restart-required'?this.job.recovery.before:this.job.recovery.after;
  return this.runningVersion===target&&environment.installedVersion===target&&!environment.blockedReason&&(await profileImage(this.adapter.profile)).digest===expected;
 }
 async afterBoot(){
  if(!['restart-required','rollback-restart-required'].includes(this.job?.state)||!await this.readyToBoot())return;
  try{this.remote.maintenance=false;await this.restoreRunState();this.job.state=this.job.state==='rollback-restart-required'?'restored':'completed';this.job.finishedAt=this.now();await this.save();}
  catch(e){this.remote.maintenance=true;await this.remote.stopRuntime();this.job.state='recovery-required';this.job.error=code(e);await this.save();}
 }
 async close(){this.closed=true;this.controller?.abort();await this.active;await this.queue.catch(()=>{});}
}
