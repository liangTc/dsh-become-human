import {ExtensionPageBridge} from './extension-page-bridge.mjs';
import {HumanUpdater} from './human-update.mjs';
import {HumanUpdateRuntime} from './human-update-runtime.mjs';
import manifest from './package.json' with {type:'json'};
import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import {getDshRuntimeVersion} from '@deepseek-ai/dsh-app-boot';
import {RuntimeSupervisor} from './supervisor.mjs';
import {rememberWebServiceHost} from './dsh-launch.mjs';
import {saveConfiguration} from './configuration-save.mjs';
import {RuntimeExtensions} from './extensions.mjs';
import {HumanOnboarding} from './onboarding.mjs';
import {RemoteGateway} from './remote.mjs';
import {SingleImIngress} from './im-ingress.mjs';
import {createHostCapabilities} from './host-capabilities.mjs';
import * as FullImPlugin from './im/lib/index.js';
import {safeOperationCode,assertOfflineStoreUnlocked,acquireRunningLock,adoptRunningLock,releaseRunningLock} from './operations-log.mjs';
export const name='become-human-manager';
export const inject=['connection','webServer','sessionController','agents'];
export const Config=z.object({sourceHome:z.string().required(false),sourceProfile:z.string().required(false),runtimeHome:z.string().required(false),runtimeProfile:z.string().required(false),runtimePort:z.number().required(false),provider:z.string().required(false),model:z.string().required(false),intervalMs:z.number().default(600000),tokenBudget:z.number().default(40000),localQuotaEnabled:z.boolean().default(false),budgetRound:z.string().default('interactive-v1'),maxTokens:z.number().required(false),maxCycles:z.number().default(1),requestTimeoutMs:z.number().required(false),interactiveOnly:z.boolean().default(true)});
export function managerStoreHome(hostHome,profileName){
  if(typeof hostHome!=='string'||!path.isAbsolute(hostHome))throw new Error('INVALID_MANAGER_HOME');
  return profileName==='desktop'?path.join(hostHome,'become-human-desktop'):hostHome;
}
export async function apply(ctx,config){
  const profile=ctx.profileContext;
  const hostHome=profile?.home??process.env.DSH_HOME??config.sourceHome;
  const managerHome=managerStoreHome(hostHome,profile?.name);
  // Web and Desktop both supply the booting CLI's manifest. An older plugin
  // installation can retain a second app-boot peer of a different version.
  let runtimeVersion=getDshRuntimeVersion();
  if(profile?.installAnchor){
    const hostPackage=JSON.parse(await fs.readFile(profile.installAnchor,'utf8'));
    if(hostPackage.name!=='@deepseek-ai/dsh')throw new Error('INVALID_DSH_INSTALL_ANCHOR');
    runtimeVersion=hostPackage.version;
  }
  assertOfflineStoreUnlocked(managerHome);
  const bootstrapHome=process.env.BH_SERVICE_MANAGER_LOCK_HOME,bootstrapNonce=process.env.BH_SERVICE_MANAGER_LOCK_NONCE;delete process.env.BH_SERVICE_MANAGER_LOCK_HOME;delete process.env.BH_SERVICE_MANAGER_LOCK_NONCE;
  const managerLease=bootstrapHome===path.resolve(managerHome)&&bootstrapNonce?adoptRunningLock(managerHome,bootstrapNonce):acquireRunningLock(managerHome);let startupRuntime,startupRemote,startupIm,startupHost,startupExtensions,startupUpdater;
  try{
  const root=path.join(managerHome,'become-human-manager');await fs.mkdir(root,{recursive:true});
  if(profile?.name&&profile.installAnchor&&profile.name!=='desktop')await rememberWebServiceHost(root,profile.name,profile.installAnchor);
  // Keep launch-time provenance private: flattened process.env may include
  // .env values that must not take precedence over managed credentials.
  const onboarding=await HumanOnboarding.create({root,config:{...config,sourceLaunchEnvironment:ctx.get('launchEnvironment')},profileContext:profile??{home:hostHome},runtimeVersion});
  const runtime=new RuntimeSupervisor(onboarding.config);
  const hostCapabilities=createHostCapabilities(ctx,{home:hostHome,getHumanSessionId:async()=>JSON.parse(await fs.readFile(path.join(runtime.config.runtimeHome,'become-human/agent.json'),'utf8')).sessionId});
  startupHost=hostCapabilities;
  runtime.capabilityHandler=(packet,signal)=>{hostCapabilities.configure(packet.context.policy,{revision:packet.context.policyRevision});return hostCapabilities.handle(packet,signal);};
  startupRuntime=runtime;
  const remote=new RemoteGateway(path.join(root,'remote.sqlite'),runtime);const im=new SingleImIngress(remote,runtime);
  onboarding.attach(runtime,input=>remote.controlRuntime(input));
  startupRemote=remote;startupIm=im;
  const extensions=await new RuntimeExtensions({root,runtime,remote}).init();startupExtensions=extensions;const pageBridge=new ExtensionPageBridge(extensions,runtime);
  const updater=await new HumanUpdater({root,adapter:new HumanUpdateRuntime({home:hostHome,profileContext:profile}),runtime,remote,runningVersion:manifest.version,dshVersion:runtimeVersion}).init();startupUpdater=updater;
  ctx.provide('becomeHumanImIngress',im);
  ctx.plugin(FullImPlugin,{dshHome:path.join(root,'im-home')});
  ctx.provide('becomeHumanRemote',Object.freeze({contractVersion:1,registerAdapter:(kind,adapter)=>remote.register(kind,adapter),receive:(channelId,envelope)=>remote.receive(channelId,envelope)}));
  let bootError;if(!await updater.readyToBoot())bootError='UPDATE_RESTART_OR_RECOVERY_REQUIRED';else if(extensions.blocked)bootError='EXTENSION_RECOVERY_REQUIRED';else if(!onboarding.required&&onboarding.supported)try{await runtime.start();await updater.afterBoot();}catch(error){bootError=safeOperationCode(error,'WORKER_START_FAILED');}
  else if(!onboarding.supported)bootError=onboarding.describe().error??onboarding.issues[0]?.code??'SETUP_ENVIRONMENT_UNSUPPORTED';
  let closing=false,tick,lastRemoteError=null;
  const latestRemoteError=(other)=>[lastRemoteError,remote.lastError,other].filter(Boolean).sort((a,b)=>b.at-a.at)[0]??null;
  const remoteFailure=(error,operation)=>{lastRemoteError={at:Date.now(),code:safeOperationCode(error,'REMOTE_OPERATION_FAILED'),operation};try{remote.recordError(error,{operation});}catch(storageError){runtime.recordLifecycle('remote-error-store-failed',{code:safeOperationCode(storageError,'REMOTE_ERROR_STORE_FAILED'),originalCode:lastRemoteError.code});}};
  const remoteStatus=()=>{try{return remote.status();}catch(error){remoteFailure(error,'remote-status');return {sessionMode:'single',unavailable:true,lastError:latestRemoteError(),channels:[],deliveries:[],deliveryParts:[]};}};
  const schedule=()=>{if(closing)return;tick=setTimeout(async()=>{try{if(!updater.blocksRuntime&&!onboarding.required&&runtime.cookie)await remote.tick();}catch(error){remoteFailure(error,'remote-tick');}finally{schedule();}},1500);};schedule();
  async function state(mode='full'){
    if(mode==='chat-state'){
      try{const chat=await runtime.state(mode);return {...chat,setup:onboarding.describe(),manager:{version:manifest.version,health:runtime.health(chat)}};}
      catch(error){return {status:'unavailable',sessionId:null,setup:onboarding.describe(),manager:{version:manifest.version,error:bootError??safeOperationCode(error,'WORKER_UNAVAILABLE'),health:runtime.health()}};}
    }
    try{const s=await runtime.state(),remoteState=remoteStatus();let imState;try{imState=await im.describe();}catch(error){remoteFailure(error,'im-describe');imState={error:safeOperationCode(error,'IM_STATUS_FAILED'),channels:[],paired:[]};}const health=runtime.health(s);if(health.status==='healthy'&&(remoteState.unavailable||imState.error))health.status='degraded';return {...s,setup:onboarding.describe(),manager:{version:manifest.version,independentProcess:true,sessionMode:'single',modelSelection:runtime.selection,health,lastRemoteError:latestRemoteError(remoteState.lastError)},remote:remoteState,im:imState};}
    catch{return {version:manifest.version,setup:onboarding.describe(),sessionId:null,desired:'paused',status:'unavailable',agentBusy:false,canThink:false,interactiveOnly:true,provider:'尚未配置',model:'',used:0,budget:config.tokenBudget,remaining:0,successes:0,intervalMs:config.intervalMs,inbox:0,persona:'',memory:'',messages:[],memories:[],attempts:[],audit:[],receipt:0,manager:{version:manifest.version,independentProcess:true,sessionMode:'single',error:bootError??runtime.lastError??(onboarding.required?'SETUP_REQUIRED':'WORKER_UNAVAILABLE'),health:runtime.health(),lastRemoteError:latestRemoteError()},remote:remoteStatus()};}
  }
  let operations=Promise.resolve();
  const mutate=input=>operations=operations.catch(()=>{}).then(async()=>{
    if(!input||typeof input!=='object')throw new Error('INVALID_REQUEST');
    if(input.op==='update-check')return updater.check(input.channel);
    if(input.op==='update-apply'){if(extensions.active||extensions.blocked)throw new Error('EXTENSION_OPERATION_BUSY');return updater.submit(input);}
    if(updater.busy||updater.blocksRuntime)throw new Error('UPDATE_RESTART_OR_RECOVERY_REQUIRED');
    if(input.op==='extension-stage'){if(onboarding.required)throw new Error('SETUP_REQUIRED');return extensions.stageArchive(input);}
    if(input.op==='extension-apply'){if(onboarding.required)throw new Error('SETUP_REQUIRED');const job=await extensions.submit(input);return {extensionJob:job};}
    if(extensions.active&&!(extensions.waitingForIdle&&['message','pause','remote-reply'].includes(input.op)))throw new Error('EXTENSION_OPERATION_BUSY');
    if(extensions.blocked&&!['runtime-stop','remote-reply','delivery-confirm'].includes(input.op))throw new Error('EXTENSION_RECOVERY_REQUIRED');
    if(input.op==='setup-refresh'){await onboarding.refresh();return state();}
    if(input.op==='setup-reset'){await onboarding.reset(input);bootError=null;return state();}
    if(input.op==='setup-complete'){await onboarding.complete(input);bootError=null;return state();}
    if(onboarding.required)throw new Error('SETUP_REQUIRED');
    if(input.op==='extension-page-prepare')return pageBridge.prepare(input);
    if(input.op==='extension-page-call')return pageBridge.call(input,'write');
    if(input.op==='configuration-save'){await saveConfiguration({runtime,remote,input});return state();}
    if(input.op==='media-upload'||input.op==='media-discard')return runtime.control(input);
    if(input.op==='remote-save')await remote.save(input);
    else if(input.op==='im-pair'){return {pair:im.beginPair(input.channel),state:await state()};}
    else if(input.op==='im-account-check'){return {account:await im.checkAccount(input.botId),state:await state()};}
    else if(input.op==='remote-enable')await remote.enable(input.id,input.enabled);
    else if(input.op==='remote-reply'){if(typeof input.enabled!=='boolean')throw new Error('INVALID_REQUEST');remote.preference('reply-enabled',input.enabled);}
    else if(input.op==='runtime-restart'){if(!onboarding.supported)throw new Error('SETUP_ENVIRONMENT_UNSUPPORTED');await remote.restartRuntime();bootError=null;}
    else if(input.op==='runtime-stop')await remote.stopRuntime();
    else if(input.op==='experience-reflection-withdraw')await runtime.control(input);
    else if(input.op==='delivery-confirm'){const delivery=await remote.confirmDelivery(input);return {state:await state(),delivery};}
    else if(['public-source-check','conversation-summary-retry','relationship-configure','work-observation-configure','work-observation-check','work-observation-retry','work-observation-forget','work-observation-annotate','board-item-create','board-item-update','board-item-transition','board-focus-set','board-focus-clear','board-reflection-apply','board-reflection-dismiss','tool-submit','tool-cancel','tool-approve','capability-configure','capability-mcp-discover','goal-revise','goal-review','goal-propose-gap','usage-prices-save','persona-development-configure','persona-development-revert','memory-lifecycle-configure','memory-lifecycle-restore','memory-lifecycle-pin','memory-lifecycle-archive','memory-lifecycle-recover','development-review-retry','action-propose-report','action-approve','action-cancel','pause','start','once','message','retry','persona','receipt','reminder-create','reminder-cancel','schedule-create','schedule-update','schedule-toggle','schedule-cancel','goal-propose','goal-transition','goal-retry','memory-save','memory-revise','memory-forget','note-revise','profile-save','profile-rollback','execution-save','data-save','skill-save','skill-toggle','skill-rollback','autonomy-configure','autonomy-pause','autonomy-resume','autonomy-retry-task','autonomy-grant','autonomy-grant-revoke','learning-feedback','learning-note-delete','session-delete-preview','session-delete-confirm','session-delete-recover','delete-fixture-preview','delete-fixture-confirm','delete-fixture-recover'].includes(input.op)){
      if(input.op==='session-delete-confirm')remote.preference('reply-enabled',false);
      const control={...input,...(input.op==='message'?{origin:'web'}:{})},result=await (['pause','start','once'].includes(input.op)?remote.controlRuntime(control):runtime.control(control));if(input.op.startsWith('action-')&&result?.action)return {state:await state(),action:result.action};if(input.op==='capability-mcp-discover'&&result?.mcpDiscovery)return {state:await state(),mcpDiscovery:result.mcpDiscovery};
    }else throw new Error('UNKNOWN_OPERATION');
    return state();
  });
  async function read(input){
    if(input.kind==='update')return updater.status();
    if(input.kind==='state'||input.kind==='chat-state')return state(input.kind==='chat-state'?'chat-state':'full');
    if(input.kind==='setup')return onboarding.refresh();
    if(input.kind==='plugin-center'){const installed=await extensions.list();let lifecycle=[],pages={pages:[],error:null};try{[lifecycle,pages]=await Promise.all([runtime.read({kind:'plugin-catalog'}),pageBridge.catalog(installed)]);}catch{pages.error='后台暂时不可用，请检查运行状态。';}return {...installed,pages:pages.pages,lifecycle,pageError:pages.error};}
    if(input.kind==='extensions')return extensions.list();
    if(input.kind==='extension-pages')return pageBridge.catalog();
    if(input.kind==='extension-page-call')return pageBridge.call(input,'read');
    const current=await runtime.state('runtime-status');if(input.sessionId&&input.sessionId!==current.sessionId)throw new Error('STALE_SESSION');
    if(input.kind==='delivery-review')return remote.deliveryReview(input);
    if(input.kind==='activity'){
      const [worker,local]=await Promise.all([runtime.read({...input,sessionId:current.sessionId}),Promise.resolve(remote.events.query(current.sessionId,input))]);
      const limit=input.limit??25,items=[...worker.items,...local.items].sort((a,b)=>b.time-a.time||(a.id<b.id?1:-1)).slice(0,limit),last=items.at(-1);
      return {items,total:worker.total+local.total,hasMore:worker.hasMore||local.hasMore||worker.items.length+local.items.length>limit,next:last?{before:last.time,beforeId:last.id}:null,tracingSince:worker.tracingSince,deliveryHistory:'timestamps recorded since native.1; earlier delivery totals remain visible in channel status'};
    }
    return runtime.read({...input,sessionId:current.sessionId});
  }
  ctx.connection.fetch.register({path:'/api/become-human-native',methods:['POST'],requestBody:'streaming',fetch:async request=>{
    let rpcId='invalid-request';const reply=result=>Response.json({type:'server-response',rpcId,result},{headers:{'Cache-Control':'no-store'}});
    try{const reader=request.body?.getReader(),parts=[];let bytes=0;if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>8388608){await reader.cancel();throw new Error('TOO_LARGE');}parts.push(Buffer.from(part.value));}
      const message=JSON.parse(Buffer.concat(parts).toString());if(typeof message?.rpcId==='string'&&message.rpcId.length<=128)rpcId=message.rpcId;
      if(bytes>786432&&!(message.payload?.method==='control'&&['media-upload','extension-stage'].includes(message.payload?.payload?.op)))throw new Error('TOO_LARGE');
      if(message?.type!=='client-request'||message.method!=='become-human-native'||!message.payload||!['read','control'].includes(message.payload.method)||!message.payload.payload||typeof message.payload.payload!=='object')throw new Error('INVALID_REQUEST');
      const value=await (message.payload.method==='read'?read(message.payload.payload):mutate(message.payload.payload));return reply({ok:true,value});
    }catch(e){const code=/^[A-Z][A-Z0-9_]{2,64}$/.test(e.message)?e.message:'NATIVE_REQUEST_FAILED';return reply({ok:false,error:{code,message:code,details:{}}});}
  }});
  ctx.connection.fetch.register({path:'/api/become-human/state',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json(await state(),{headers:{'Cache-Control':'no-store'}})});
  ctx.connection.fetch.register({path:'/api/become-human/im-catalog',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json(await im.describe(),{headers:{'Cache-Control':'no-store'}})});
  ctx.connection.fetch.register({path:'/api/become-human/control',methods:['POST'],requestBody:'streaming',fetch:async request=>{
    try{const reader=request.body?.getReader(),parts=[];let bytes=0;if(reader)while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>8388608){await reader.cancel();return Response.json({error:'TOO_LARGE'},{status:413});}parts.push(Buffer.from(r.value));}const input=JSON.parse(Buffer.concat(parts).toString());if(bytes>8192&&!['media-upload','extension-stage'].includes(input.op))return Response.json({error:'TOO_LARGE'},{status:413});return Response.json(await mutate(input));}
    catch(error){const code=error.message;return Response.json({error:/^[A-Z][A-Z0-9_]{2,64}$/.test(code)?code:'MANAGER_CONTROL_FAILED'},{status:error.status??400});}
  }});
  const serve=(route,file,type,transform)=>ctx.webServer.register({path:route,kind:'exact',handler:async(req,res)=>{
    if(!ctx.connection.authorizeIndex(req,res))return;if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    let body=await fs.readFile(new URL(file,import.meta.url),'utf8');if(transform)body=await transform(body);
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(body);
  }});
  ctx.webServer.register({path:'/become-human-extension-client.js',kind:'exact',handler:async(req,res)=>{
    if(!ctx.connection.authorizeIndex(req,res))return;if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    try{const url=new URL(req.url,'http://localhost'),script=await pageBridge.script({key:url.searchParams.get('key'),fingerprint:url.searchParams.get('fingerprint')});res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(script);}catch{res.writeHead(409,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('EXTENSION_PAGE_UNAVAILABLE');}
  }});
  serve('/become-human','./runtime/panel.html','text/html',async html=>html.replace('</main>',(await fs.readFile(new URL('./remote-panel.html',import.meta.url),'utf8'))+'</main>').replace('</body>','<script src="/become-human-remote.js" defer></script></body>'));
  serve('/become-human-client.js','./runtime/client.js','text/javascript');serve('/become-human-remote.js','./remote-client.js','text/javascript');
  if(profile?.name!=='desktop')await fs.writeFile(path.join(root,'launch.json'),JSON.stringify({url:ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port+'/')}));
  ctx.effect(()=>async()=>{closing=true;clearTimeout(tick);if(runtime.runtimeLease)runtime.recordLifecycle('manager-shutdown-requested');await im.close();await operations.catch(error=>runtime.recordLifecycle('manager-control-failed-on-close',{code:safeOperationCode(error,'MANAGER_CONTROL_FAILED')}));await updater.close();await extensions.close();await hostCapabilities.close();await remote.close();await runtime.close();releaseRunningLock(managerLease);});
  }catch(error){
    let stopped=true;for(const component of [startupUpdater,startupExtensions,startupHost,startupIm,startupRemote,startupRuntime])if(component)try{await component.close();}catch(closeError){stopped=false;startupRuntime?.recordLifecycle('manager-start-cleanup-failed',{code:safeOperationCode(closeError,'MANAGER_CLEANUP_FAILED')});}
    if(stopped)releaseRunningLock(managerLease);throw error;
  }
}
