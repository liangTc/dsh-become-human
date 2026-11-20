// Opt-in Windows acceptance test:
// node scripts/verify-desktop-install.mjs --exe "C:\path\DeepSeek Harness.exe" --tgz "C:\path\dsh-become-human-web.tgz"
// --cache-dir optionally reuses package downloads. All profiles and Agent data
// are new per run. The Desktop CLI may contact npm to install dependencies.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{exe:{type:'string'},tgz:{type:'string'},'cache-dir':{type:'string'}}});
if(process.platform!=='win32'||!values.exe||!values.tgz)throw Error('Expected Windows and --exe <Desktop executable> --tgz <Human package>');
const exe=await fs.realpath(values.exe),tgz=await fs.realpath(values.tgz);
assert.ok(exe.toLowerCase().endsWith('.exe')&&tgz.toLowerCase().endsWith('.tgz'));
const resources=path.join(path.dirname(exe),'resources'),runtime=path.join(resources,'app.asar','dsh'),support=path.join(resources,'runtime');
await Promise.all([fs.access(path.join(resources,'app.asar')),fs.access(path.join(support,'bin'))]);
const tmp=await fs.realpath(os.tmpdir());
const home=await fs.mkdtemp(path.join(tmp,'human-desktop-'));
const profile=path.join(home,'profiles','desktop');
const cache=values['cache-dir']?path.resolve(values['cache-dir']):path.join(home,'package-cache');
const fixtureModel='fixture-chat',provider='desktop-install-fixture',key=randomUUID();
const input='桌面安装验收 '+randomUUID(),answer='桌面会话已收到 '+randomUUID()+'。';
const seen=[],scope=new AbortController();
let active,stage='fixture',expectedVersion,hostVersion;
const workerExits=[];
const systemEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(?:APPDATA|LOCALAPPDATA|USERPROFILE|TEMP|TMP|PATH|PATHEXT|SystemRoot|SystemDrive|ComSpec|WINDIR|ProgramData|ProgramFiles(?:\(x86\))?|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|NODE_EXTRA_CA_CERTS)$/i.test(k)));
const env={...systemEnv,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',BH_QA_SYNTHETIC_API_KEY:key,
 PNPM_HOME:path.join(cache,'pnpm-home'),XDG_CACHE_HOME:path.join(cache,'metadata'),npm_config_cache:path.join(cache,'npm'),npm_config_registry:'https://registry.npmjs.org/'};
const fixture=http.createServer(async(req,res)=>{
 try{
  assert.equal(req.method,'POST');assert.equal(req.url,'/v1/chat/completions');
  assert.equal(req.headers.authorization,'Bearer '+key);
  let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw Error('FIXTURE_REQUEST_TOO_LARGE');}
  const request=JSON.parse(body);assert.equal(request.model,fixtureModel);assert.ok(Array.isArray(request.messages));
  const review=request.messages.map(row=>{try{return JSON.parse(row.content);}catch{return null;}}).find(row=>Array.isArray(row?.replyUnits));
  if(!review)assert.ok(body.includes(input),'Owner message missing in model request');
  const reply=JSON.stringify(review?{unitChecks:review.replyUnits.map(({id})=>({id,purpose:'answer',basis:'对应本次专用验收消息。'})),assessment:'包含测试回执。',decision:'accept',issues:[]}:{reply:answer});
  seen.push(review?'review':'reply');
  const base={id:'chatcmpl-'+randomUUID(),created:Math.floor(Date.now()/1000),model:fixtureModel};
  const usage={prompt_tokens:18,completion_tokens:9,total_tokens:27};
  if(request.stream){
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
   const event=(choices,extra={})=>res.write('data: '+JSON.stringify({...base,object:'chat.completion.chunk',choices,...extra})+'\n\n');
   event([{index:0,delta:{role:'assistant',content:reply},finish_reason:null}]);
   event([{index:0,delta:{},finish_reason:'stop'}]);event([],{usage});res.end('data: [DONE]\n\n');
  }else{
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:reply},finish_reason:'stop'}],usage}));
  }
 }catch{seen.push('unexpected-request');res.writeHead(400);res.end();}
});

function launch(args,ipc){
 const child=spawn(exe,args,{cwd:profile,env,windowsHide:true,stdio:['ignore','pipe','pipe',...(ipc?['ipc']:[])]});
 const result={child,exit:once(child,'exit'),diagnostic:''};active=result;
 // Keep only sanitized error codes for diagnosis. Never print the host login URL.
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
  const codes=String(chunk).match(/\b(?:ERR_|ERROR_|MODEL_|SOURCE_|UPDATE_|DSH_|WORKER_|SETUP_|PNPM_)[A-Z_\d]+\b/g);
  if(codes)result.diagnostic=(result.diagnostic+' '+codes.join(' ')).slice(-600);
 });
 return result;
}
async function closeActive(){
 if(!active)return;
 const run=active;active=undefined;
 if(!run.child.pid||run.child.exitCode!==null||run.child.signalCode!==null)return;
 if(run.child.connected)run.child.send({type:'shutdown'},()=>{});
 if(await Promise.race([run.exit.then(()=>true),delay(10000,false,{ref:false})]))return;
 // On Windows a killed host can otherwise leave a worker behind. Only target
 // descendants of our own child; the test never uses a port or process name.
 const killer=spawn('taskkill.exe',['/pid',String(run.child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
 await once(killer,'exit');await run.exit;
}
function deadline(ms,what){return delay(ms,undefined,{signal:scope.signal,ref:false}).then(()=>{throw Error(what+' timed out');});}
async function withHost(previous){
 stage=previous?'restart':'first-launch';
 const run=launch(['--expose-internals',path.join(runtime,'node_modules','@deepseek-ai','dsh-desktop-host','lib','index.js'),runtime,profile,path.join(support,'primary-runtime'),path.join(support,'primary-runtime','dependencies','pnpm','bin','pnpm.mjs'),path.join(support,'bin')],true);
 try{
  const ready=await Promise.race([
   new Promise((resolve,reject)=>run.child.on('message',msg=>{if(msg?.type==='ready')resolve(new URL(msg.url));if(msg?.type==='fatal')reject(Error('Desktop startup failed'));})),
   run.exit.then(([code])=>{throw Error('Desktop exited '+code+' '+run.diagnostic);}),deadline(90000,'Desktop startup')]);
  assert.equal(ready.hostname,'127.0.0.1');assert.equal(ready.protocol,'http:');
  const login=await fetch(ready,{redirect:'manual',signal:AbortSignal.timeout(10000)});assert.equal(login.status,303);
  const cookie=login.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');assert.ok(cookie);
  const rpc=async(method,payload)=>{
   const resp=await fetch(new URL('/api/become-human-native',ready),{method:'POST',headers:{cookie,origin:ready.origin,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'become-human-native',payload:{method,payload}}),signal:AbortSignal.timeout(90000)});
   assert.equal(resp.status,200);const packet=await resp.json();if(!packet.result?.ok)throw Error('Human RPC '+(packet.result?.error?.code??'INVALID_PACKET'));return packet.result.value;
  };
  const state=await rpc('read',{kind:'state'});
  assert.equal(state.setup.environment.sourceProfile,'desktop');assert.equal(state.setup.environment.supported,true);assert.equal(state.manager.version,expectedVersion);
  hostVersion=state.setup.environment.dsh;
  if(!previous){
   stage='onboarding';assert.equal(state.setup.required,true);
   assert.ok(state.setup.models.some(m=>m.provider===provider&&m.model===fixtureModel&&m.credentialReady));
   await rpc('control',{op:'setup-complete',requestId:randomUUID(),expectedRevision:state.setup.revision,provider,model:fixtureModel,ownerName:'',personaPreset:'zhiqiu',budgetPreset:'low',timeZone:'Asia/Shanghai',startAutonomy:false});
  }else assert.equal(state.setup.required,false);
  let chat=await rpc('read',{kind:'chat-state'});assert.ok(chat.sessionId);
  if(previous)assert.equal(chat.sessionId,previous);
  else{
   stage='chat';await rpc('control',{op:'message',sessionId:chat.sessionId,requestId:randomUUID(),text:input});
   const until=Date.now()+50000;
   do{
    chat=await rpc('read',{kind:'chat-state'});
    if(chat.messages?.some(row=>row.kind==='assistant'&&row.text===answer))break;
    if(Date.now()>until)throw Error('Missing reply; model requests='+seen.join(',')+'; last error='+(chat.run?.lastError?.code??chat.lastError??'none')+'; host='+run.diagnostic);
    await delay(350);
   }while(true);
  }
  for(const [kind,text] of [['user',input],['assistant',answer]])assert.equal(chat.messages.filter(row=>row.kind===kind&&row.text===text).length,1,'Durable '+kind+' message count');
  const processFile=path.join(home,'become-human-desktop','become-human-manager','runtime-home','manager-process.json');
  const info=JSON.parse(await fs.readFile(processFile,'utf8'));
  assert.equal(info.managerPid,run.child.pid);assert.ok(Number.isSafeInteger(info.workerPid)&&info.workerPid>0&&info.workerPid!==info.managerPid);
  run.workerPid=info.workerPid;return chat.sessionId;
 }finally{
  await closeActive();
  if(run.workerPid){
   // The host completed its shutdown protocol; independently verify its
   // observed worker exited too, without signaling any process to terminate.
   const until=Date.now()+3000;
   while(true){
    try{process.kill(run.workerPid,0);}catch(error){if(error.code!=='ESRCH')throw error;break;}
    assert.ok(Date.now()<until,'Private worker still running after host shutdown');await delay(100);
   }
   workerExits.push(true);
  }
 }
}
try{
 await fs.mkdir(profile,{recursive:true});
 fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
 const baseURL='http://127.0.0.1:'+fixture.address().port+'/v1';
 await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'human-desktop-acceptance',private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
 await fs.writeFile(path.join(profile,'pnpm-workspace.yaml'),'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
 const patches=[{id:'llm-pi-ai',config:{providers:{[provider]:{displayName:'Local fixture',api:'openai-completions',baseURL,apiKeyEnv:'BH_QA_SYNTHETIC_API_KEY',models:[{id:fixtureModel,name:'Fixture'}]}}}},{id:'agent-default-model',config:{provider,model:fixtureModel}},...['hmr','session-title-llm','desktop-product-telemetry','product-analytics','session-telemetry-otel','session-log-deepseek','session-log-download','plugin-package-inventory-deepseek'].map(id=>({id,disabled:true}))];
 await fs.writeFile(path.join(profile,'cordis.patch.yml'),JSON.stringify(patches,null,2));
 stage='install';
 const cli="import path from 'node:path';import {pathToFileURL} from 'node:url';const resources=process.resourcesPath;const {runDesktopCli}=await import(pathToFileURL(path.join(resources,'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')));process.argv=[process.execPath,'dsh','plugin','--profile','desktop','add',process.argv[1]];await runDesktopCli(path.join(resources,'runtime'));";
 const install=launch(['--expose-internals','--input-type=module','-e',cli,tgz],false);
 const [code]=await Promise.race([install.exit,deadline(240000,'Desktop plugin installation')]);
 if(code!==0)throw Error('Desktop CLI exit '+code+' '+install.diagnostic);
 const installed=JSON.parse(await fs.readFile(path.join(profile,'node_modules','dsh-become-human-web','package.json'),'utf8'));expectedVersion=installed.version;
 assert.equal(installed.name,'dsh-become-human-web');
 console.log('Installed '+installed.name+'@'+expectedVersion+' with Desktop CLI in a fresh profile.');
 const first=await withHost();assert.ok(seen.includes('reply'));assert.ok(!seen.includes('unexpected-request'));
 const firstCalls=seen.length;await withHost(first);assert.equal(seen.length,firstCalls,'Restart redispatched a completed turn');
 assert.equal(workerExits.length,2);
 console.log(JSON.stringify({desktop:hostVersion,installedVersion:expectedVersion,onboarding:true,modelRequests:seen,ownerMessages:1,assistantMessages:1,restartPreservedSession:true,hostAndWorkerShutdowns:workerExits.length,realProviderCalls:0}));
}catch(error){throw new Error(stage+' failed: '+error.message);}
finally{
 scope.abort();await closeActive();
 fixture.closeAllConnections();if(fixture.listening)await new Promise(resolve=>fixture.close(resolve));
 assert.equal(path.dirname(await fs.realpath(home)),tmp);
 await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:150});
}
