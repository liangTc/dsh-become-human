// Run with Node for Web or with the packaged Desktop executable in Node mode.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {nodeChild,resolveDshEntry,resolveDshManifest} from '../plugins/become-human-web/dsh-launch.mjs';

const tempRoot=await fs.realpath(os.tmpdir());
const home=await fs.mkdtemp(path.join(tempRoot,'human-worker-smoke-'));
const worker=path.resolve(import.meta.dirname,'../plugins/become-human-web/worker.mjs');
const profile='human-worker-smoke';
const dir=path.join(home,'profiles',profile);
const probe=path.join(dir,'node_modules','human-worker-probe');
const manifest=JSON.parse(await fs.readFile(resolveDshManifest(),'utf8'));
if(process.versions.electron)assert.ok(resolveDshManifest().startsWith(path.join(process.resourcesPath,'app.asar','dsh')+path.sep));
let child,ended;
try{
  const server=net.createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  server.close();
  await once(server,'close');
  await fs.mkdir(probe,{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:profile,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','human-worker-probe']}}}));
  await fs.writeFile(path.join(probe,'package.json'),JSON.stringify({name:'human-worker-probe',version:'1.0.0',type:'module',main:'index.mjs',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
  await fs.writeFile(path.join(probe,'cordis.patch.yml'),'- insert:\n    - id: human-worker-probe\n      name: human-worker-probe\n');
  await fs.writeFile(path.join(probe,'index.mjs'),`export const inject=['connection','webServer'];
export function apply(ctx){
  ctx.connection.fetch.register({path:'/api/human-worker-probe',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json({ready:true})});
  const url=ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port+'/');
  process.send({url});
}`);
  await fs.writeFile(path.join(home,'runtime-selection.json'),JSON.stringify({apiKeyEnv:'HUMAN_SMOKE_KEY',apiKeyEnvs:['HUMAN_SMOKE_KEY']}));
  const launch=nodeChild(worker,[],{...process.env,BH_RUNTIME_HOME:home,BH_RUNTIME_PROFILE:profile,BH_RUNTIME_PORT:String(port),BH_DSH_ENTRY:resolveDshEntry(),HUMAN_SMOKE_KEY:'fixture-only'});
  child=spawn(process.execPath,launch.args,{env:launch.env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-6000);});
  const ready=once(child,'message',{signal:AbortSignal.timeout(45000)});
  ended=once(child,'exit');
  const [message]=await Promise.race([ready,ended.then(([code])=>{throw Error('Worker exited '+code+' '+output.replace(/([?&]token=)[^\s]+/g,'$1[redacted]'));})]);
  const url=new URL(message.url);
  assert.equal(url.origin,'http://127.0.0.1:'+port);
  const login=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5000)});
  assert.equal(login.status,303);
  const cookie=login.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
  assert.ok(cookie);
  let reply;
  for(let attempt=0;attempt<30;attempt++){
    reply=await fetch(new URL('/api/human-worker-probe',url),{headers:{cookie},signal:AbortSignal.timeout(5000)});
    if(reply.status!==503)break;
    await reply.body?.cancel();
    await delay(100);
  }
  assert.equal(reply.status,200);
  assert.deepEqual(await reply.json(),{ready:true});
  console.log('Verified private worker, IPC and authenticated HTTP on DSH '+manifest.version+' / '+(process.versions.electron?'Electron '+process.versions.electron:'Node '+process.versions.node));
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await ended;}
  if(path.dirname(await fs.realpath(home))!==tempRoot)throw Error('UNEXPECTED_TEMP_DIRECTORY');
  await fs.rm(home,{recursive:true,force:true,maxRetries:4});
}
