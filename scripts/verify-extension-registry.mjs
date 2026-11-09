// Real DSH CLI + pnpm over a controlled HTTP registry. Runtime restart is a
// lifecycle fixture; this does not claim public npm or a fresh DSH deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');
registerHooks({resolve(name,context,next){try{return next(name,context);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}});
const {RuntimeExtensions}=await import('../plugins/become-human-web/extensions.mjs');
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'human-registry-')),runtimeHome=path.join(root,'home'),profile=path.join(runtimeHome,'profiles','fixture'),name='dsh-human-registry-fixture-'+randomUUID().slice(0,8),requests=[],checks=[];
await fs.mkdir(profile,{recursive:true});await fs.writeFile(path.join(profile,'package.json'),JSON.stringify({name:'human-registry-profile',private:true,type:'module',dependencies:{},dsh:{profile:{bundles:[]}}}));
function archive(files){const chunks=[];for(const [name,body] of Object.entries(files)){const bytes=Buffer.from(body),h=Buffer.alloc(512);h.write('package/'+name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h[156]=48;h.write('ustar\0',257);h.write('00',263);h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);chunks.push(h,bytes,Buffer.alloc((512-bytes.length%512)%512));}return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));}
const packages=new Map();
for(const version of ['1.0.0','1.1.0','2.0.0']){const manifest={name,version,type:'module',main:'index.mjs',dsh:{bundle:{patch:'./cordis.patch.yml'}},scripts:{postinstall:'node -e "require(\'node:fs\').writeFileSync(\'install-script-ran\',\'unexpected\')"'}};const bytes=archive({'package.json':JSON.stringify(manifest),'index.mjs':'export const name="registry-fixture";export function apply(){}','cordis.patch.yml':`- insert:\n    - id: ${version==='2.0.0'?'become-human':'human-extension.registry-fixture'}\n      name: ${name}\n      config: {mode: default}\n`});packages.set(version,{manifest,bytes});}
let base;
const broken=archive({'package.json':JSON.stringify({name,version:'0.9.0',type:'module',main:'index.mjs',dsh:{bundle:{patch:'./cordis.patch.yml'}}}),'index.mjs':'export function apply(){}','cordis.patch.yml':'- insert:\n    - id: human-extension.broken\n      name: @unquoted/broken\n'});
packages.set('0.9.0',{manifest:{name,version:'0.9.0'},bytes:broken});
const server=http.createServer((req,res)=>{const url=new URL(req.url,base);requests.push({method:req.method,path:url.pathname});if(url.pathname==='/'+name){const versions=Object.fromEntries([...packages].map(([version,p])=>[version,{...p.manifest,dist:{tarball:base+'/tar/'+version+'.tgz',integrity:'sha512-'+createHash('sha512').update(p.bytes).digest('base64'),shasum:createHash('sha1').update(p.bytes).digest('hex')}}]));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({name,'dist-tags':{latest:'2.0.0'},versions}));}else{const m=/^\/tar\/(.+)\.tgz$/.exec(url.pathname),pkg=m&&packages.get(m[1]);if(pkg){res.setHeader('Content-Type','application/octet-stream');res.end(pkg.bytes);}else{res.statusCode=404;res.setHeader('Content-Type','application/json');res.end('{"error":"Not found"}');}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
// Keep the test registry on the whole private profile: pnpm removal may also
// verify its lockfile against that registry, not just installation.
await fs.writeFile(path.join(profile,'.npmrc'),'registry='+base+'\nfetch-retries=0\n');
const fixture={starts:0,stops:0,resumes:0,state:{sessionId:'isolated-registry-test',desired:'paused',cancelEpoch:1,lastError:null,autonomy:{paused:false}}};
const runtime={config:{runtimeHome,sourceHome:path.join(root,'host'),runtimeProfile:'fixture'},state:async()=>fixture.state,start:async()=>{fixture.starts++;},recordLifecycle(){}};
const remote={stopRuntime:async()=>{fixture.stops++;fixture.state.desired='paused';},controlRuntime:async()=>{fixture.resumes++;}};
const manager=await new RuntimeExtensions({root:path.join(root,'manager'),runtime,remote,cliOptions:['--registry='+base,'--fetch-retries=0','--store-dir='+path.join(root,'store'),'--cache-dir='+path.join(root,'cache')]}).init();
// Only move directories created by this isolated fixture. No user package
// cache, real profile or production process is touched.
async function moveFixture(from,to){for(const file of [from,to])if(!path.resolve(file).startsWith(path.resolve(root)+path.sep))throw Error('FIXTURE_PATH_ESCAPE');const stat=await fs.lstat(from);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('FIXTURE_DIRECTORY_REQUIRED');await fs.rename(from,to);}
async function submit(value){const input={requestId:randomUUID(),expectedRevision:(await manager.list()).revision,trustedCode:true,...value};const job=await manager.submit(input);await manager.active;const result=(await manager.list()).jobs.find(j=>j.id===job.id);return {input,result};}
async function passed(name,fn){await fn();checks.push({name,passed:true});console.log(JSON.stringify(checks.at(-1)));}
try{
 await passed('Malformed first install restores empty cold profile without failed internal lockfile',async()=>{
  const before=await fs.readFile(path.join(profile,'package.json'),'utf8');
  const r=await submit({action:'install',source:name+'@0.9.0'});
  assert.equal(r.result.status,'failed');assert.equal(r.result.code,'EXTENSION_CLI_FAILED');assert.equal(r.result.recovery.status,'restored',JSON.stringify(r.result));
  assert.equal(await fs.readFile(path.join(profile,'package.json'),'utf8'),before);assert.equal((await manager.list()).items.length,0);assert.equal(fixture.resumes,0);
  assert.equal(r.result.recovery.isolatedModules.length,1);assert((await fs.lstat(path.join(profile,r.result.recovery.isolatedModules[0]))).isDirectory());
  await assert.rejects(()=>fs.access(path.join(profile,'node_modules',name)));
 });
 await passed('Exact version uses real metadata and tarball download through standard DSH CLI',async()=>{const r=await submit({action:'install',source:name+'@1.0.0'});assert.equal(r.result.status,'completed',JSON.stringify(r.result));const item=(await manager.list()).items[0];assert.equal(item.version,'1.0.0');assert.equal(item.manageable,true);assert(requests.some(r=>r.path==='/'+name));assert(requests.some(r=>r.path==='/tar/1.0.0.tgz'));assert.equal(fixture.resumes,0);});
 await passed('Lifecycle scripts remain disabled',async()=>{await assert.rejects(()=>fs.access(path.join(profile,'node_modules',name,'install-script-ran')));});
 await passed('Same-name registry update retains the existing extension configuration',async()=>{await submit({action:'configure',name,entries:[{id:'human-extension.registry-fixture',disabled:true,config:{mode:'preserved'}}]});const r=await submit({action:'install',source:name+'@1.1.0'});assert.equal(r.result.status,'completed');const item=(await manager.list()).items[0];assert.equal(item.version,'1.1.0');assert.deepEqual(item.nodes[0].config,{mode:'preserved'});assert(item.nodes[0].disabled);});
 await passed('Lost-response resubmission returns the same completed operation without a second CLI call',async()=>{const r=await submit({action:'install',source:name+'@1.1.0'}),before={requests:requests.length,stops:fixture.stops};const again=await manager.submit(r.input);assert.equal(again.id,r.result.id);assert.equal(requests.length,before.requests);assert.equal(fixture.stops,before.stops);});
 await passed('Invalid registry upgrade restores locked old version and configuration offline',async()=>{const starts=fixture.starts,r=await submit({action:'install',source:name+'@2.0.0'});assert.equal(r.result.code,'EXTENSION_NAMESPACE_REQUIRED');assert.equal(r.result.recovery.status,'restored',JSON.stringify(r.result));assert.equal(fixture.starts,starts+1);const old=(await manager.list()).items[0];assert.equal(old.version,'1.1.0');assert(old.registered&&old.nodes[0].disabled);assert.equal(old.nodes[0].config.mode,'preserved');assert.equal(fixture.resumes,0);});
 await passed('Missing offline cache keeps recovery blocked across manager restart until an explicit retry',async()=>{
  const originalRun=manager.run,store=path.join(root,'store'),modules=path.join(profile,'node_modules'),storeBackup=path.join(root,'store-backup'),modulesBackup=path.join(root,'modules-backup');let evicted=false,offlineRequests,offlineCalls=0;
  manager.run=async packet=>{if(packet.args[0]==='install'){offlineRequests=requests.length;offlineCalls++;}await originalRun(packet);if(!evicted&&packet.args[0]==='add'&&packet.args[1]===name+'@2.0.0'){
   evicted=true;const moduleConfig=await fs.readFile(path.join(modules,'.modules.yaml'));await moveFixture(store,storeBackup);await moveFixture(modules,modulesBackup);await fs.mkdir(path.join(modules,name),{recursive:true});await fs.writeFile(path.join(modules,'.modules.yaml'),moduleConfig);await fs.writeFile(path.join(modules,name,'package.json'),JSON.stringify(packages.get('2.0.0').manifest));await fs.writeFile(path.join(modules,name,'cordis.patch.yml'),'- id: become-human\n  name: '+name+'\n');
  }};
  const starts=fixture.starts,failed=await submit({action:'install',source:name+'@2.0.0'});assert(evicted);assert.equal(failed.result.status,'failed');assert.equal(failed.result.code,'EXTENSION_NAMESPACE_REQUIRED');assert.equal(failed.result.recovery.status,'failed');assert.equal(failed.result.recovery.code,'EXTENSION_CLI_FAILED');assert.equal(fixture.starts,starts);assert.equal(offlineCalls,1);assert.equal(requests.length,offlineRequests,'Offline restoration must not request registry content');assert(failed.result.canRecover);
  await manager.close();const next=await new RuntimeExtensions({root:path.join(root,'manager'),runtime,remote,cliOptions:manager.cliOptions,run:originalRun}).init();try{
   assert(next.blocked);assert.equal(next.canRecover(next.blocked),true);assert.equal(fixture.starts,starts);const beforeRequests=requests.length;
   const input={requestId:randomUUID(),expectedRevision:(await next.list()).revision,trustedCode:true,action:'recover',operationId:failed.result.id};
   await assert.rejects(()=>next.submit({...input,action:'remove',name,operationId:undefined}),/EXTENSION_RECOVERY_REQUIRED/);
   if(await fs.lstat(store).catch(()=>null))await moveFixture(store,path.join(root,'empty-store'));await moveFixture(storeBackup,store);await moveFixture(modules,path.join(root,'incomplete-modules'));await moveFixture(modulesBackup,modules);
   const recovered=await next.submit(input);await next.active;assert.equal(next.jobs.at(-1).status,'completed');assert.equal(next.blocked,null);assert.equal(fixture.starts,starts+1);assert.equal(fixture.resumes,0);assert.equal(requests.length,beforeRequests);const old=(await next.list()).items[0];assert.equal(old.version,'1.1.0');assert.equal(old.nodes[0].disabled,true);assert.equal(old.nodes[0].config.mode,'preserved');const startsAfter=fixture.starts;assert.equal((await next.submit(input)).id,recovered.id);assert.equal(fixture.starts,startsAfter);
   manager.jobs=next.jobs;
  }finally{await next.close();manager.closed=false;manager.run=originalRun;}
 });
 await passed('Restored registry extension remains explicitly removable',async()=>{const r=await submit({action:'remove',name});assert.equal(r.result.status,'completed');assert.equal((await manager.list()).items.length,0);assert.equal(fixture.resumes,0);});
 await passed('Registry 404 leaves original failure evidence and restores the paused runtime',async()=>{const starts=fixture.starts,r=await submit({action:'install',source:name+'-missing@1.0.0'});assert.equal(r.result.code,'EXTENSION_CLI_FAILED');assert.equal(r.result.recovery.status,'restored',JSON.stringify(r.result));assert.equal(fixture.starts,starts+1);assert.equal(fixture.resumes,0);assert.equal((await manager.list()).items.length,0);});
}catch(e){checks.push({name:'registry integration',passed:false,error:e.stack});console.error(e.stack);process.exitCode=1;}
finally{await manager.close();await new Promise(r=>server.close(r));const result={at:new Date().toISOString(),root,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length,checks,requests,lifecycle:fixture,scope:'Actual local HTTP registry and DSH CLI/pnpm; synthetic packages and runtime lifecycle fixture. No public npm or production runtime modifications.'};if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed,root}));}
