import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import YAML from 'yaml';
import {readSourceModelConfiguration} from './source-models.mjs';
import {readSourceCredentialReferences} from './source-credentials.mjs';
import {runtimeAttachmentLimits} from './runtime/multimodal.mjs';
export {readSourceModelConfiguration} from './source-models.mjs';
import {OperationsLog,operationsLogPolicy,safeOperationCode,assertOfflineStoreUnlocked,acquireRunningLock,releaseRunningLock,assertRunningLock} from './operations-log.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function availablePort(){
  return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>{const address=server.address();server.close(error=>error?reject(error):resolve(address.port));});});
}
export class RuntimeSupervisor {
  constructor(config){this.config=config;this.autoPort=config.runtimePort===undefined;this.cookie=null;this.child=null;this.closed=false;this.base=config.runtimePort?'http://127.0.0.1:'+config.runtimePort:null;this.waiting=null;this.managerBootId=crypto.randomUUID();this.startedAt=Date.now();this.workerBootId=null;this.lastExit=null;this.lastRequestError=null;this.logs=new OperationsLog(config.runtimeHome,()=>({managerBootId:this.managerBootId,workerBootId:this.workerBootId,managerPid:process.pid,workerPid:this.child?.pid??null}));}
  recordLifecycle(kind,data={}){return this.logs.lifecycle(kind,data);}
  acquireRuntimeLease(){if(this.runtimeLease){assertRunningLock(this.runtimeLease);return;}this.runtimeLease=acquireRunningLock(this.config.runtimeHome);this.logs.lease=this.runtimeLease;}
  releaseRuntimeLease(){releaseRunningLock(this.runtimeLease);this.runtimeLease=null;this.logs.lease=null;}
  async stopChild(child){if(!child||child.exitCode!==null||child.signalCode!==null)return true;child.__humanStopRequested=true;const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([ended,sleep(5000)]);return child.exitCode!==null||child.signalCode!==null;}
  installCapabilityBridge(child){
    const active=new Map();
    const send=message=>{if(child.connected)child.send(message,()=>{});};
    child.on('message',async message=>{
      if(message?.kind==='human-capability-cancel'){active.get(message.id)?.abort(new Error('CAPABILITY_CANCELLED'));return;}
      if(message?.kind!=='human-capability-request')return;
      const {id,operation,input,context}=message;
      const reject=code=>send({kind:'human-capability-result',id,error:code});
      if(this.closed||this.child!==child||typeof id!=='string'||id.length>64||typeof operation!=='string'||!context||Buffer.byteLength(JSON.stringify(message))>65536)return reject('INVALID_CAPABILITY_REQUEST');
      // Cancellation never releases this gate before the Host operation really
      // settles. A late external side effect cannot overlap a new operation.
      if(active.size)return reject('CAPABILITY_BRIDGE_BUSY');
      const controller=new AbortController();active.set(id,controller);
      try{
        const identity=JSON.parse(await fs.readFile(path.join(this.config.runtimeHome,'become-human/agent.json'),'utf8'));
        if(context.agent!==identity.sessionId||typeof this.capabilityHandler!=='function')throw new Error('CAPABILITY_BRIDGE_UNAVAILABLE');
        const result=await this.capabilityHandler({operation,input,context},controller.signal);
        if(Buffer.byteLength(JSON.stringify(result??null))>524288)throw new Error('CAPABILITY_RESULT_TOO_LARGE');
        send({kind:'human-capability-result',id,result});
      }catch(error){reject(safeOperationCode(error,'CAPABILITY_BRIDGE_FAILED'));}
      finally{active.delete(id);}
    });
    child.once('exit',()=>{for(const controller of active.values())controller.abort(new Error('CAPABILITY_BRIDGE_DISCONNECTED'));});
  }
  health(state){
    const alive=!!this.child&&this.child.exitCode===null&&this.child.signalCode===null,available=alive&&!!this.cookie&&!this.closed;
    return {status:this.closed?'closed':this.waiting?'starting':!available?'unavailable':this.lastRequestError||this.logs.lastError?'degraded':'healthy',managerBootId:this.managerBootId,workerBootId:this.workerBootId,managerPid:process.pid,workerPid:this.child?.pid??null,startedAt:this.startedAt,lastReadyAt:this.lastReadyAt??null,lastExit:this.lastExit,lastError:this.lastRequestError??(this.lastError?{at:this.lastErrorAt??null,code:this.lastError}:null),logError:this.logs.lastError,logs:operationsLogPolicy,recovery:{policy:'manual-paused',requiresExplicitStart:true,canRestart:!this.waiting,canResume:available&&state?.desired==='paused'&&!state?.agentBusy&&!state?.retiring,reason:!available?'worker-unavailable':state?.desired==='paused'?(state?.stopReason??'cold-start'):null}};
  }
  async prepare(){
    const c=this.config;if(!path.isAbsolute(c.runtimeHome)||!path.isAbsolute(c.sourceHome)||c.runtimeHome===c.sourceHome)throw new Error('INVALID_RUNTIME_HOME');
    assertOfflineStoreUnlocked(c.runtimeHome);
    this.acquireRuntimeLease();
    if(!/^[a-zA-Z0-9_-]+$/.test(c.sourceProfile)||!/^[a-zA-Z0-9_-]+$/.test(c.runtimeProfile)||!Number.isInteger(c.runtimePort)||c.runtimePort<1024||c.runtimePort>65535)throw new Error('INVALID_RUNTIME_CONFIG');
    await fs.mkdir(c.runtimeHome,{recursive:true});if(await fs.realpath(c.runtimeHome)!==path.resolve(c.runtimeHome))throw new Error('LINKED_RUNTIME_HOME');
    const source=await readSourceModelConfiguration(c);
    const providerId=c.provider??source.defaultRoute?.provider,modelId=c.model??source.defaultRoute?.model;
    const selected=source.models.find(route=>route.provider===providerId&&route.model===modelId);
    if(!selected)throw new Error('MODEL_ROUTE_REQUIRES_SETUP');
    if(!selected.credentialReady)throw new Error('MODEL_CREDENTIAL_MISSING');
    const native=selected.adapter==='deepseek-native';
    const original=(native?source.nativeProviders:source.providers)[providerId];
    if(!original||!original.models?.some(m=>m.id===modelId))throw new Error('MODEL_ROUTE_REQUIRES_SETUP');
    const provider=structuredClone(original);
    if(!provider.apiKeyEnv)throw new Error('MODEL_CREDENTIAL_REFERENCE_MISSING');
    provider.retryPolicy={mode:'normal',maxRetries:0};if(!native)provider.timeoutMs=c.requestTimeoutMs;provider.streamIdleTimeoutMs=c.requestTimeoutMs;
    const safeProviders=Object.create(null);for(const [key,value] of Object.entries(source.readyProviders)){const clean=structuredClone(value);clean.retryPolicy={mode:'normal',maxRetries:0};clean.timeoutMs=120000;clean.streamIdleTimeoutMs=120000;safeProviders[key]=clean;}
    const safeNativeProviders=Object.create(null);for(const [key,value] of Object.entries(source.readyNativeProviders)){const clean=structuredClone(value);clean.retryPolicy={mode:'normal',maxRetries:0};clean.streamIdleTimeoutMs=120000;safeNativeProviders[key]=clean;}
    (native?safeNativeProviders:safeProviders)[providerId]=provider;
    const readyRoutes=source.models.filter(route=>route.credentialReady),seen=new Set();
    this.modelCapabilities=readyRoutes.filter(route=>{const key=JSON.stringify([route.provider,route.model]);if(seen.has(key))return false;seen.add(key);return true;}).map(({provider,model,adapter,reasoningEfforts,inputModalities})=>({provider,model,adapter,...(reasoningEfforts?{reasoningEfforts}: {}),...(inputModalities?{inputModalities}: {})}));
    this.allowedRoutes=this.modelCapabilities.map(({provider,model})=>({provider,model}));
    const profile=path.join(c.runtimeHome,'profiles',c.runtimeProfile);await fs.mkdir(path.join(profile,'node_modules'),{recursive:true});
    for(const [name,target] of [['dsh-become-human-web',import.meta.dirname],['dsh-become-human-runtime',path.join(import.meta.dirname,'runtime-bundle')]]){
      const link=path.join(profile,'node_modules',name);
      try{await fs.symlink(target,link,'junction');}catch(e){if(e.code!=='EEXIST')throw e;const existing=await fs.lstat(link);if(!existing.isSymbolicLink())throw new Error('PROFILE_PACKAGE_CONFLICT');if(await fs.realpath(link)!==await fs.realpath(target)){await fs.unlink(link);await fs.symlink(target,link,'junction');}}
    }
    await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'become-human-private-runtime',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-become-human-runtime']}}},null,2));
    const patch=[{id:'attachment-local',config:runtimeAttachmentLimits},{id:'llm-pi-ai',config:{providers:safeProviders}},{id:'llm-deepseek',name:'@deepseek-ai/dsh-llm-deepseek-api-key',disabled:!safeNativeProviders['deepseek-official'],config:safeNativeProviders['deepseek-official']??{}},{id:'agent-default-model',config:{provider:providerId,model:modelId}},{id:'become-human',config:{provider:providerId,model:modelId,allowedRoutes:this.allowedRoutes,modelCapabilities:this.modelCapabilities,tokenBudget:c.tokenBudget,localQuotaEnabled:c.localQuotaEnabled,budgetRound:c.budgetRound,maxTokens:c.maxTokens,maxCycles:c.maxCycles,intervalMs:c.intervalMs,requestTimeoutMs:c.requestTimeoutMs,interactiveOnly:c.interactiveOnly}},...['hmr','session-title-llm','session-log-deepseek','session-log-download','plugin-package-inventory-deepseek','desktop-product-telemetry','product-analytics','session-telemetry-otel','ui-settings-account','account-controller'].map(id=>({id,disabled:true}))];
    await fs.writeFile(path.join(profile,'cordis.patch.yml'),YAML.stringify(patch));await fs.writeFile(path.join(c.runtimeHome,'runtime-selection.json'),JSON.stringify({provider:providerId,model:modelId,apiKeyEnv:provider.apiKeyEnv,apiKeyEnvs:[...new Set([...Object.values(safeProviders),...Object.values(safeNativeProviders)].map(p=>p.apiKeyEnv))]}));
    this.selection={provider:providerId,model:modelId};
  }
  async start(){
    if(this.waiting)return this.waiting;
    if(this.child&&this.child.exitCode===null&&this.child.signalCode===null)throw new Error('WORKER_ALREADY_RUNNING');
    let startingChild;
    this.waiting=(async()=>{
      if(this.closed)throw new Error('RUNTIME_CLOSED');
      if(!path.isAbsolute(this.config.runtimeHome)||!path.isAbsolute(this.config.sourceHome)||this.config.runtimeHome===this.config.sourceHome)throw new Error('INVALID_RUNTIME_HOME');
      assertOfflineStoreUnlocked(this.config.runtimeHome);
      this.acquireRuntimeLease();
      this.lastError=null;this.lastRequestError=null;this.workerBootId=null;
      this.recordLifecycle('runtime-start-requested',{recoveryPolicy:'manual-paused'});
      if(this.autoPort){this.config.runtimePort=await availablePort();this.base='http://127.0.0.1:'+this.config.runtimePort;}
      // An occupied port is never adopted: only this manager's child is trusted.
      const occupied=await fetch(this.base,{signal:AbortSignal.timeout(800)}).then(()=>true,()=>false);if(occupied)throw new Error('RUNTIME_PORT_ALREADY_IN_USE');
      await this.prepare();
      const launchFile=path.join(this.config.runtimeHome,'become-human/launch.json');
      await fs.unlink(launchFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
      const require=createRequire(import.meta.url),dshManifest=require.resolve('@deepseek-ai/dsh/package.json');
      const dshEntry=path.join(path.dirname(dshManifest),JSON.parse(await fs.readFile(dshManifest,'utf8')).bin.dsh);
      const selection=JSON.parse(await fs.readFile(path.join(this.config.runtimeHome,'runtime-selection.json'),'utf8'));
      const credentials=await readSourceCredentialReferences(this.config,selection.apiKeyEnvs);
      if(!credentials.get(selection.apiKeyEnv))throw new Error('MODEL_CREDENTIAL_MISSING');
      const childEnv={...process.env};
      for(const ref of selection.apiKeyEnvs){
        // Remove inherited, possibly materialized .env values before applying
        // the source's resolved precedence. Values never enter a disk record.
        for(const key of Object.keys(childEnv))if(process.platform==='win32'?key.toUpperCase()===ref.toUpperCase():key===ref)delete childEnv[key];
        if(credentials.has(ref))childEnv[ref]=credentials.get(ref);
      }
      const child=spawn(process.execPath,[path.join(import.meta.dirname,'worker.mjs')],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...childEnv,BH_DSH_ENTRY:dshEntry,BH_RUNTIME_HOME:this.config.runtimeHome,BH_RUNTIME_PROFILE:this.config.runtimeProfile,BH_RUNTIME_PORT:String(this.config.runtimePort)}});this.child=child;this.installCapabilityBridge(child);
      startingChild=child;
      this.recordLifecycle('worker-spawned',{runtimePort:this.config.runtimePort});
      await fs.writeFile(path.join(this.config.runtimeHome,'manager-process.json'),JSON.stringify({managerPid:process.pid,workerPid:child.pid,runtimePort:this.config.runtimePort,source:'manager-owned child process'}));
      let launchReady=false;
      for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',chunk=>{const text=String(chunk);if(text.includes('dsh web:'))launchReady=true;this.logs.output(name,text,child.pid);});
      child.once('error',error=>{if(this.child===child){this.lastError='WORKER_SPAWN_FAILED';this.lastErrorAt=Date.now();}this.recordLifecycle('worker-spawn-error',{code:safeOperationCode(error,'WORKER_SPAWN_FAILED'),workerPid:child.pid??null});});
      child.once('exit',(exitCode,signal)=>{const exit={at:Date.now(),exitCode,signal:signal??null,expected:this.closed||child.__humanStopRequested===true};this.lastExit=exit;if(this.child===child){if(!exit.expected){this.lastError=signal?'WORKER_EXIT_SIGNAL':'WORKER_EXIT_'+exitCode;this.lastErrorAt=exit.at;}this.cookie=null;}this.recordLifecycle('worker-exited',{...exit,workerPid:child.pid??null});});
      for(let i=0;i<150;i++){
        if(child.exitCode!==null||this.lastError==='WORKER_SPAWN_FAILED')throw new Error(this.lastError??'WORKER_EXIT');
        if(launchReady){
          let link;try{link=JSON.parse(await fs.readFile(launchFile,'utf8'));}catch(error){if(error.code==='ENOENT'){await sleep(200);continue;}throw error;}
          const login=new URL(link.url);if(login.hostname!=='127.0.0.1'||Number(login.port)!==this.config.runtimePort)throw new Error('INVALID_WORKER_LOGIN');login.pathname='/';
          const result=await fetch(login,{redirect:'manual'});if(result.status!==303){await sleep(200);continue;}
          this.cookie=result.headers.getSetCookie().map(r=>r.split(';')[0]).join('; ');
          try{const state=await this.state();this.workerBootId=state.bootId??null;this.lastReadyAt=Date.now();this.recordLifecycle('worker-ready',{sessionId:state.sessionId,desired:state.desired,recoveryPolicy:'manual-paused'});return;}catch(error){if(error.status===404||error.status===401){this.cookie=null;await sleep(200);continue;}throw error;}
        }
        await sleep(200);
      }
      throw new Error('WORKER_START_TIMEOUT');
    })().catch(async error=>{this.lastError=safeOperationCode(error,'WORKER_START_FAILED');this.lastErrorAt=Date.now();this.recordLifecycle('runtime-start-failed',{code:this.lastError});const stopped=await this.stopChild(startingChild);if(stopped){try{this.releaseRuntimeLease();}catch(lockError){this.recordLifecycle('runtime-lock-release-failed',{code:safeOperationCode(lockError,'RUNNING_STORE_LOCK_CHANGED')});}}else this.recordLifecycle('worker-stop-timeout',{code:'WORKER_STOP_TIMEOUT'});throw error;}).finally(()=>{this.waiting=null;});return this.waiting;
  }
  async request(resource,body){
    if(!this.cookie||!this.child||this.child.exitCode!==null)throw new Error('WORKER_UNAVAILABLE');
    let response;try{response=await fetch(this.base+'/api/become-human/'+resource,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{cookie:this.cookie,...(body?{'Content-Type':'application/json'}:{})},redirect:'error',signal:AbortSignal.timeout(45000)});}catch(error){const code=safeOperationCode(error,'WORKER_REQUEST_FAILED');if(this.lastRequestError?.code!==code)this.recordLifecycle('worker-request-failed',{code,operation:resource.split('?')[0]});this.lastRequestError={at:Date.now(),code};throw error;}
    let data;try{data=await response.json();}catch{const code='WORKER_RESPONSE_INVALID';if(this.lastRequestError?.code!==code)this.recordLifecycle('worker-request-failed',{code,operation:resource.split('?')[0]});this.lastRequestError={at:Date.now(),code};throw new Error(code);}
    if(!response.ok){const error=new Error(data.error??'WORKER_REQUEST_FAILED');error.status=response.status;if(response.status>=500){const code=safeOperationCode(error,'WORKER_SERVER_ERROR');if(this.lastRequestError?.code!==code)this.recordLifecycle('worker-request-failed',{code,operation:resource.split('?')[0],status:response.status});this.lastRequestError={at:Date.now(),code};}throw error;}
    if(this.lastRequestError){this.recordLifecycle('worker-request-recovered',{operation:resource.split('?')[0]});this.lastRequestError=null;}return data;
  }
  state(){return this.request('state');}
  control(body){return this.request('control',body);}
  read(body){return this.request('read',body);}
  events(after=0){return this.request('events?after='+after);}
  async close(){this.closed=true;this.recordLifecycle('runtime-stop-requested');if(this.cookie)await this.control({op:'pause'}).catch(error=>{this.recordLifecycle('runtime-pause-on-close-failed',{code:safeOperationCode(error,'WORKER_PAUSE_FAILED')});});if(!await this.stopChild(this.child)){this.lastError='WORKER_STOP_TIMEOUT';this.lastErrorAt=Date.now();this.recordLifecycle('worker-stop-timeout',{code:this.lastError});throw new Error(this.lastError);}this.cookie=null;this.recordLifecycle('runtime-stopped');this.releaseRuntimeLease();}
}
