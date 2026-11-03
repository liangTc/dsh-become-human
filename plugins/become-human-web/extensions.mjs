import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,execFile} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import YAML from 'yaml';
import {runtimeExtensionPatch,behaviorReplacementIds,workflowIds,externalBehaviorOwners,runtimeProfileManifest} from './runtime-profile.mjs';
import {extensionEditors,validateEditorEntries} from './extension-config.mjs';
import {researchUrl} from './runtime/public-document.mjs';
import {ExtensionRecovery,profileImage} from './extension-recovery.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),fail=code=>{throw Error(code);};
const packageName=value=>typeof value==='string'&&/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
const protectedNames=new Set(['@deepseek-ai/dsh','@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-become-human-runtime','dsh-become-human-web','dsh-become-human']);
const editable=name=>packageName(name)&&!protectedNames.has(name)&&!name.startsWith('@deepseek-ai/');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const errorCode=e=>/^[A-Z][A-Z0-9_]{2,64}$/.test(e?.message??'')?e.message:'EXTENSION_OPERATION_FAILED';
async function regular(file,{optional=false,limit=524288}={}){try{const s=await fs.lstat(file);if(s.isSymbolicLink()||!s.isFile()||s.size>limit)fail('EXTENSION_FILE_INVALID');return await fs.readFile(file);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}}
async function atomic(file,value){const tmp=file+'.'+randomUUID()+'.tmp';await regular(file,{optional:true,limit:24*1024*1024});try{await fs.writeFile(tmp,value,{flag:'wx'});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
export function extensionTarget(source){
  if(typeof source!=='string'||source.length>2048||/[\x00-\x1f]/.test(source)||source!==source.trim())fail('EXTENSION_SOURCE_INVALID');
  if(path.isAbsolute(source)){if(!/\.tgz$/i.test(source))fail('EXTENSION_ARCHIVE_REQUIRED');return {kind:'archive',path:source};}
  const m=/^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.exec(source);
  if(!m||!editable(m[1]))fail('EXTENSION_SOURCE_INVALID');return {kind:'registry',name:m[1],version:m[2],spec:source};
}
export function archiveManifest(bytes){
  let tar;try{tar=gunzipSync(bytes,{maxOutputLength:32*1024*1024});}catch{fail('EXTENSION_ARCHIVE_INVALID');}
  let found;
  for(let offset=0;offset+512<=tar.length;){
    const h=tar.subarray(offset,offset+512);if(h.every(v=>v===0))break;
    const str=(a,b)=>h.subarray(a,b).toString('utf8').replace(/\0.*$/s,'').trim(),name=[str(345,500),str(0,100)].filter(Boolean).join('/'),type=str(156,157);
    const sizeText=str(124,136),sumText=str(148,156);if(!/^[0-7]+$/.test(sizeText)||!/^[0-7]+$/.test(sumText))fail('EXTENSION_ARCHIVE_INVALID');
    const size=parseInt(sizeText,8),checksum=h.reduce((n,b,i)=>n+(i>=148&&i<156?32:b),0);
    if(checksum!==parseInt(sumText,8)||!name.startsWith('package/')||name.includes('\\')||name.split('/').some(p=>p==='..'||p==='.')||!['','0','5'].includes(type)||offset+512+size>tar.length)fail('EXTENSION_ARCHIVE_INVALID');
    if(name==='package/package.json'){if(found||size>524288)fail('EXTENSION_ARCHIVE_INVALID');try{found=JSON.parse(tar.subarray(offset+512,offset+512+size).toString());}catch{fail('EXTENSION_ARCHIVE_INVALID');}}
    offset+=512+Math.ceil(size/512)*512;
  }
  if(!found||!editable(found.name)||typeof found.version!=='string'||typeof found.dsh?.bundle?.patch!=='string')fail('EXTENSION_PACKAGE_UNSUPPORTED');
  return found;
}
export async function runExtensionCli({entry,home,profile,args,signal}){
  const env={};for(const key of ['PATH','Path','PATHEXT','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','ComSpec','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','HOME','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'])if(process.env[key])env[key]=process.env[key];
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(import.meta.dirname,'extension-worker.mjs'),entry,home,profile,...args],{env,windowsHide:true,stdio:'ignore',shell:false});let aborted=false;
    const abort=()=>{aborted=true;if(!child.pid)return;if(process.platform==='win32')execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});else child.kill('SIGTERM');};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.once('error',()=>{signal?.removeEventListener('abort',abort);reject(Error('EXTENSION_CLI_START_FAILED'));});
    child.once('exit',code=>{signal?.removeEventListener('abort',abort);if(aborted)reject(Error('EXTENSION_INSTALL_INTERRUPTED'));else if(code!==0)reject(Error('EXTENSION_CLI_FAILED'));else resolve();});
  });
}
export class RuntimeExtensions {
  constructor({root,runtime,remote,run=runExtensionCli,cliOptions=[]}){this.root=path.join(root,'extensions');this.runtime=runtime;this.remote=remote;this.run=run;this.cliOptions=cliOptions;this.active=null;this.closed=false;}
  async init(){
    await fs.mkdir(this.root,{recursive:true});const stat=await fs.lstat(this.root);if(!stat.isDirectory()||stat.isSymbolicLink())fail('EXTENSION_FILE_INVALID');
    this.file=path.join(this.root,'operations.json');this.jobs=JSON.parse((await regular(this.file,{optional:true,limit:4*1024*1024}))?.toString()??'[]');
    if(!Array.isArray(this.jobs))fail('EXTENSION_HISTORY_INVALID');
    for(const job of this.jobs)if(['queued','running'].includes(job.status)){job.status='interrupted';job.code='EXTENSION_INSTALL_INTERRUPTED';job.finishedAt=Date.now();}
    await this.save();return this;
  }
  async save(){await atomic(this.file,JSON.stringify(this.jobs,null,2));}
  get recoveryStore(){return new ExtensionRecovery(this.root,this.profile);}
  get blocked(){return this.jobs.findLast(j=>j.recovery&&!['committed','restored'].includes(j.recovery.status))??null;}
  canRecover(job){return !!job?.recovery&&['failed','prepared'].includes(job.recovery.status)&&!!job.recovery.after;}
  async cli(args,signal){
    const manifestFile=createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8')),entry=path.resolve(path.dirname(manifestFile),manifest.bin.dsh);
    const text=await regular(path.join(this.profile,'node_modules','.modules.yaml'),{optional:true}),modules=text?YAML.parse(text.toString()):null,store=modules?.storeDir;
    const storeArgs=typeof store==='string'&&path.isAbsolute(store)?['--store-dir='+(/^v\d+$/.test(path.basename(store))?path.dirname(store):store)]:[];
    return this.run({entry,home:this.runtime.config.runtimeHome,profile:this.runtime.config.runtimeProfile,args:[...args,...storeArgs,...(args[0]==='remove'?[]:this.cliOptions)],signal:AbortSignal.any([signal,AbortSignal.timeout(180000)])});
  }
  async verifyBehaviorOwnership(ready,signal){
    const list=await this.list(),claimed=list.items.filter(item=>item.registered&&(item.replacesBehaviors?.length||item.providesWorkflows?.length));
    if(!claimed.length)return;
    for(let attempt=0;attempt<11;attempt++){
      signal.throwIfAborted();const behaviors=await this.runtime.read({kind:'behavior-catalog',sessionId:ready.sessionId}),workflows=claimed.some(item=>item.providesWorkflows?.length)?await this.runtime.read({kind:'workflow-catalog',sessionId:ready.sessionId}):[];
      const catalog=Array.isArray(behaviors)&&Array.isArray(workflows)?[...behaviors,...workflows]:null;
      if(Array.isArray(catalog)&&claimed.every(item=>[...(item.replacesBehaviors??[]),...(item.providesWorkflows??[])].every(id=>catalog.filter(row=>row.id===id).length===(item.nodes.some(node=>!node.disabled)?1:0))))return;
      if(attempt<10)await new Promise(resolve=>setTimeout(resolve,100));
    }
    fail('EXTENSION_BEHAVIOR_REGISTRATION_FAILED');
  }
  async recover(job,signal){
    const snapshot=await this.recoveryStore.load(job);
    if((await profileImage(this.profile)).digest!==job.recovery.after)fail('EXTENSION_RECOVERY_CONFLICT');
    await this.remote.stopRuntime();signal.throwIfAborted();
    if((await profileImage(this.profile)).digest!==job.recovery.after)fail('EXTENSION_RECOVERY_CONFLICT');
    job.recovery.status='restoring';await this.save();
    try{
      await this.recoveryStore.restoreFiles(snapshot);signal.throwIfAborted();
      if(snapshot.packages){await this.cli(['install',snapshot.files['pnpm-lock.yaml']?'--frozen-lockfile':'--config.lockfile=false','--offline','--ignore-scripts'],signal);await this.recoveryStore.verifyPackages(snapshot);await this.recoveryStore.restoreFiles(snapshot);}
      if((await profileImage(this.profile)).digest!==snapshot.digest)fail('EXTENSION_RECOVERY_VERIFY_FAILED');
      job.recovery.filesVerified=true;this.runtime.closed=false;await this.runtime.start();const ready=await this.runtime.state();
      await this.verifyBehaviorOwnership(ready,signal);
      if(snapshot.sessionId&&ready.sessionId!==snapshot.sessionId){await this.remote.stopRuntime();fail('STALE_SESSION');}
      if(ready.desired!=='paused'){await this.remote.stopRuntime();fail('EXTENSION_RECOVERY_NOT_PAUSED');}
      job.recovery={...job.recovery,status:'restored',finishedAt:Date.now(),runtime:'paused',code:null};await this.save();await this.recoveryStore.discard(job.id).catch(()=>{job.recovery.cleanupPending=true;});
    }catch(error){
      await this.runtime.close?.().catch(()=>{});job.recovery.status=signal.aborted?'interrupted':'failed';job.recovery.code=errorCode(error);
      job.recovery.after=(await profileImage(this.profile)).digest;await this.save();throw error;
    }
  }
  get profile(){const c=this.runtime.config;if(!path.isAbsolute(c.runtimeHome)||c.runtimeHome===c.sourceHome||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.runtimeProfile))fail('INVALID_RUNTIME_HOME');return path.join(c.runtimeHome,'profiles',c.runtimeProfile);}
  async configuration(){
    const stat=await fs.lstat(this.profile);if(!stat.isDirectory()||stat.isSymbolicLink())fail('EXTENSION_FILE_INVALID');
    const manifestText=(await regular(path.join(this.profile,'package.json'))).toString(),patchText=(await regular(path.join(this.profile,'human-extensions.patch.yml'),{optional:true}))?.toString()??'';
    const manifest=JSON.parse(manifestText),patch=runtimeExtensionPatch(patchText?YAML.parse(patchText,{uniqueKeys:true}):[]);
    return {manifest,patch,revision:hash(manifestText+'\0'+patchText)};
  }
  async describe(name,patch){
    if(!editable(name))fail('EXTENSION_PACKAGE_PROTECTED');
    const directory=path.join(this.profile,'node_modules',name),manifest=JSON.parse((await regular(path.join(directory,'package.json'))).toString()),relative=manifest.dsh?.bundle?.patch;
    if(manifest.name!==name||typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.split('/').includes('..'))fail('EXTENSION_PACKAGE_UNSUPPORTED');
    const patchFile=path.resolve(directory,relative);if(!patchFile.startsWith(path.resolve(directory)+path.sep))fail('EXTENSION_PACKAGE_UNSUPPORTED');
    const installedRoot=await fs.realpath(directory),actualFile=await fs.realpath(patchFile);if(!actualFile.startsWith(installedRoot+path.sep))fail('EXTENSION_FILE_INVALID');
    const layers=YAML.parse((await regular(patchFile)).toString(),{uniqueKeys:true});
    if(!Array.isArray(layers))fail('EXTENSION_NAMESPACE_REQUIRED');
    const nodes=layers.flatMap(layer=>plain(layer)&&Object.keys(layer).length===1&&Array.isArray(layer.insert)?layer.insert:[layer]);
    if(!Array.isArray(nodes)||!nodes.length||nodes.length>64||nodes.some(n=>!plain(n)||typeof n.id!=='string'||!/^human-extension\.[a-z0-9][a-z0-9._-]{0,120}$/.test(n.id))||new Set(nodes.map(n=>n.id)).size!==nodes.length)fail('EXTENSION_NAMESPACE_REQUIRED');
    return {name,version:manifest.version,description:typeof manifest.description==='string'?manifest.description.slice(0,300):'',replacesBehaviors:behaviorReplacementIds(manifest),providesWorkflows:workflowIds(manifest),configEditors:extensionEditors(manifest,nodes),nodes:nodes.map(n=>({id:n.id,disabled:patch.find(p=>p.id===n.id)?.disabled??!!n.disabled,config:patch.find(p=>p.id===n.id)?.config??n.config??{}}))};
  }
  async list(){
    const c=await this.configuration(),bundles=c.manifest.dsh?.profile?.bundles??[],names=[...new Set([...bundles,...this.jobs.map(j=>j.name).filter(name=>Object.hasOwn(c.manifest.dependencies??{},name))])].filter(editable),items=[];
    for(const name of names)try{items.push({...await this.describe(name,c.patch),manageable:bundles.includes(name),registered:bundles.includes(name),...(!bundles.includes(name)?{code:'EXTENSION_NOT_REGISTERED'}:{})});}catch(e){items.push({name,manageable:false,registered:bundles.includes(name),code:errorCode(e),nodes:[]});}
    return {revision:c.revision,items,jobs:this.jobs.slice(-20).reverse().map(j=>({...j,canRecover:this.canRecover(j)})),recoveryRequired:this.blocked?{id:this.blocked.id,name:this.blocked.name,canRecover:this.canRecover(this.blocked)}:null,busy:!!this.active,scope:'human-private-runtime',trustedCode:true,installScripts:false};
  }
  submit(input){const next=(this.submission??Promise.resolve()).catch(()=>{}).then(()=>this.submitOne(input));this.submission=next;return next;}
  async submitOne(input){
    if(this.closed)fail('EXTENSION_MANAGER_CLOSED');
    if(!plain(input)||!['install','remove','toggle','configure','recover'].includes(input.action)||typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId)||input.trustedCode!==true)fail('EXTENSION_REQUEST_INVALID');
    const basis=hash(JSON.stringify({action:input.action,source:input.source,name:input.name,enabled:input.enabled,entries:input.entries,operationId:input.operationId,expectedRevision:input.expectedRevision}));
    const old=this.jobs.find(j=>j.requestId===input.requestId);if(old){if(old.basis!==basis)fail('REQUEST_ID_CONFLICT');return {...old};}
    if(this.active)fail('EXTENSION_OPERATION_BUSY');if(this.jobs.length>=1000)fail('EXTENSION_HISTORY_FULL');
    const c=await this.configuration();if(input.expectedRevision!==c.revision)fail('EXTENSION_CONFIGURATION_CHANGED');
    if(input.action==='recover'){
      const original=this.blocked;if(!original||original.id!==input.operationId||!this.canRecover(original))fail('EXTENSION_RECOVERY_UNAVAILABLE');
      if((await profileImage(this.profile)).digest!==original.recovery.after)fail('EXTENSION_RECOVERY_CONFLICT');
      const job={id:randomUUID(),requestId:input.requestId,basis,action:'recover',name:original.name,operationId:original.id,status:'queued',createdAt:Date.now(),code:null};this.jobs.push(job);await this.save();
      const controller=new AbortController();this.controller=controller;this.remote.maintenance=true;
      this.active=(async()=>{try{job.status='running';await this.save();await this.recover(original,controller.signal);job.status='completed';job.runtime='paused';}catch(e){job.status='failed';job.code=errorCode(e);}finally{job.finishedAt=Date.now();await this.save();this.active=null;this.controller=null;this.remote.maintenance=false;}})();this.active.catch(()=>{});return {...job};
    }
    if(this.blocked)fail('EXTENSION_RECOVERY_REQUIRED');
    let target,name=input.name;
    if(input.action==='install'){
      target=extensionTarget(input.source);if(target.kind==='archive'){const bytes=await regular(target.path,{limit:20*1024*1024}),manifest=archiveManifest(bytes),sha256=hash(bytes);name=manifest.name;const staged=path.join(this.root,sha256+'.tgz');try{await fs.writeFile(staged,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(hash(await regular(staged,{limit:20*1024*1024}))!==sha256)fail('EXTENSION_ARCHIVE_CHANGED');}target={kind:'archive',path:staged,name,version:manifest.version,sha256};}
      else name=target.name;
    }else if(!editable(name)||!(c.manifest.dsh?.profile?.bundles??[]).includes(name)&&!Object.hasOwn(c.manifest.dependencies??{},name))fail('EXTENSION_PACKAGE_PROTECTED');
    let descriptor;if(input.action==='remove')try{descriptor=await this.describe(name,c.patch);}catch{}
    if(['toggle','configure'].includes(input.action)){descriptor=await this.describe(name,c.patch);if(input.action==='toggle'&&typeof input.enabled!=='boolean')fail('EXTENSION_REQUEST_INVALID');if(input.action==='configure'){runtimeExtensionPatch(input.entries);const ids=new Set(descriptor.nodes.map(n=>n.id));if(input.entries.length!==ids.size||input.entries.some(n=>!ids.has(n.id)))fail('EXTENSION_CONFIGURATION_INVALID');}}
    if(input.action==='configure'||input.action==='toggle'&&input.enabled){
      const proposed=input.action==='configure'?input.entries:descriptor.nodes.map(n=>({...n,disabled:!input.enabled})),active=validateEditorEntries(descriptor,proposed,researchUrl);
      const all=await this.list();for(const other of all.items.filter(i=>i.name!==name&&i.manageable))for(const source of validateEditorEntries(other,other.nodes,researchUrl))if(active.has(source))fail('EXTENSION_SOURCE_ID_CONFLICT');
    }
    const job={id:randomUUID(),requestId:input.requestId,basis,action:input.action,name,version:target?.version??null,status:'queued',createdAt:Date.now(),code:null};
    this.jobs.push(job);await this.save();
    const controller=new AbortController();this.controller=controller;this.remote.maintenance=true;
    this.active=this.execute(job,{...input,target,descriptor,configuration:c},controller.signal).finally(()=>{this.active=null;this.controller=null;this.remote.maintenance=false;});
    this.active.catch(()=>{});return {...job};
  }
  async execute(job,input,signal){
    try{
      job.status='running';await this.save();let previous;try{previous=await this.runtime.state();}catch{}
      if(input.sessionId&&previous?.sessionId&&input.sessionId!==previous.sessionId)fail('STALE_SESSION');
      const resume=previous?.desired==='running'&&!previous.lastError&&!previous.autonomy?.paused;
      await this.remote.stopRuntime();signal.throwIfAborted();
      // Check again after stopping: an external CLI or editor may have changed
      // the profile since the management preview.
      const current=await this.configuration();if(current.revision!==input.configuration.revision)fail('EXTENSION_CONFIGURATION_CHANGED');
      const identity=JSON.parse((await regular(path.join(this.runtime.config.runtimeHome,'become-human','agent.json'),{optional:true}))?.toString()??'null');
      const expectedSession=previous?.sessionId??input.sessionId??identity?.sessionId??null;
      if(identity?.sessionId&&expectedSession!==identity.sessionId)fail('STALE_SESSION');
      job.recovery=await this.recoveryStore.capture(job.id,{packages:['install','remove'].includes(job.action),sessionId:expectedSession});await this.save();
      job.recovery.status='mutating';await this.save();
      if(['install','remove'].includes(job.action)){
        const args=job.action==='remove'?['remove',job.name]:['add',input.target.kind==='archive'?input.target.path:input.target.spec,'--ignore-scripts'];
        await this.cli(args,signal);
      }
      let after=await this.configuration(),patch=after.patch;
      if(job.action==='install'){
        const installed=await this.describe(job.name,patch);if(installed.version!==input.target.version||!(after.manifest.dsh?.profile?.bundles??[]).includes(job.name))fail('EXTENSION_INSTALL_VERIFICATION_FAILED');
        const all=await this.list(),ids=all.items.flatMap(i=>i.nodes.map(n=>n.id));if(ids.length!==new Set(ids).size)fail('EXTENSION_NODE_CONFLICT');
        await externalBehaviorOwners(this.profile,runtimeProfileManifest(after.manifest));
        const sources=new Set();for(const item of all.items.filter(i=>i.manageable))for(const source of validateEditorEntries(item,item.nodes,researchUrl)){if(sources.has(source))fail('EXTENSION_SOURCE_ID_CONFLICT');sources.add(source);}
      }else if(job.action==='remove'){
        if((after.manifest.dsh?.profile?.bundles??[]).includes(job.name))fail('EXTENSION_REMOVE_VERIFICATION_FAILED');
        const ids=new Set(input.descriptor?.nodes.map(n=>n.id)??[]);
        patch=patch.filter(n=>!ids.has(n.id));
      }else{
        const ids=new Set(input.descriptor.nodes.map(n=>n.id)),replacement=job.action==='configure'?input.entries:input.descriptor.nodes.map(n=>({id:n.id,config:n.config,disabled:!input.enabled}));
        patch=[...patch.filter(n=>!ids.has(n.id)),...replacement];
      }
      runtimeExtensionPatch(patch);if(JSON.stringify(patch)!==JSON.stringify(after.patch))await atomic(path.join(this.profile,'human-extensions.patch.yml'),YAML.stringify(patch));
      job.recovery.after=(await profileImage(this.profile)).digest;job.recovery.status='starting';await this.save();
      signal.throwIfAborted();this.runtime.closed=false;await this.runtime.start();const ready=await this.runtime.state();
      await this.verifyBehaviorOwnership(ready,signal);
      if(previous?.sessionId&&ready.sessionId!==previous.sessionId){await this.runtime.close();fail('STALE_SESSION');}
      if(resume){this.remote.maintenance=false;await this.remote.controlRuntime({op:'start',sessionId:ready.sessionId,expectedEpoch:ready.cancelEpoch});}
      job.status='completed';job.finishedAt=Date.now();job.runtime='started';job.resumed=!!resume;
      job.recovery.status='committed';await this.save();await this.recoveryStore.discard(job.id).catch(()=>{job.recovery.cleanupPending=true;});
    }catch(e){
      job.status=signal.aborted?'interrupted':'failed';job.code=errorCode(e);job.finishedAt=Date.now();job.runtime='check-required';
      if(job.recovery&&!['committed','restored'].includes(job.recovery.status)){
        if(signal.aborted){job.recovery.status='interrupted';job.recovery.code='EXTENSION_RECOVERY_INSPECTION_REQUIRED';}
        else try{job.recovery.after=(await profileImage(this.profile)).digest;job.recovery.status='failed';await this.save();await this.recover(job,signal);job.runtime='restored-paused';}
        catch(error){job.recovery.code=errorCode(error);}
      }
    }
    finally{job.finishedAt=Date.now();await this.save();this.runtime.recordLifecycle?.('extension-operation',{action:job.action,name:job.name,status:job.status,code:job.code,recovery:job.recovery?.status??null});}
  }
  async close(){this.closed=true;this.controller?.abort(Error('EXTENSION_INSTALL_INTERRUPTED'));await this.active;}
}
