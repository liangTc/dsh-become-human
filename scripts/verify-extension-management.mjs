import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');
registerHooks({resolve(name,context,next){try{return next(name,context);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...context,parentURL:pathToFileURL(anchor).href});}}});
const {RuntimeExtensions,extensionTarget,archiveManifest}=await import('../plugins/become-human-web/extensions.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'human-extensions-')),cases=[];
async function test(name,fn){const dir=path.join(root,randomUUID()),runtimeHome=path.join(dir,'runtime'),profile=path.join(runtimeHome,'profiles','test');await fs.mkdir(profile,{recursive:true});const manifest={name:'fixture',private:true,dependencies:{'dsh-human-example':'1.0.0'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-human-example','dsh-become-human-runtime']}}};await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(manifest));
 const pkg=path.join(profile,'node_modules','dsh-human-example');await fs.mkdir(pkg,{recursive:true});await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'dsh-human-example',version:'1.0.0',description:'Fixture',dsh:{bundle:{patch:'./cordis.patch.yml'}}}));await fs.writeFile(path.join(pkg,'cordis.patch.yml'),'- id: human-extension.example\n  name: dsh-human-example\n  config:\n    enabled: true\n');
 await fs.writeFile(path.join(profile,'pnpm-lock.yaml'),'lockfileVersion: 9.0\n');
 const f={dir,profile,pkg,manifest,calls:[],state:{sessionId:'preserved-session',desired:'running',cancelEpoch:1,lastError:null,autonomy:{paused:false}},starts:0,stops:0,resumes:0,failStart:false};
 f.runtime={config:{runtimeHome,sourceHome:path.join(dir,'host'),runtimeProfile:'test'},state:async()=>f.state,start:async()=>{f.starts++;if(f.failStart)throw Error('WORKER_START_FAILED');},recordLifecycle:()=>{}};
 f.remote={stopRuntime:async()=>{f.stops++;f.state={...f.state,desired:'paused'};},controlRuntime:async input=>{assert.equal(input.sessionId,'preserved-session');f.resumes++;f.state={...f.state,desired:'running'};}};
 f.run=async packet=>{f.calls.push(packet.args);const m=JSON.parse(await fs.readFile(path.join(profile,'package.json')));if(packet.args[0]==='remove'){m.dsh.profile.bundles=m.dsh.profile.bundles.filter(n=>n!==packet.args[1]);delete m.dependencies[packet.args[1]];await fs.writeFile(path.join(profile,'package.json'),JSON.stringify(m));}};
 f.manager=await new RuntimeExtensions({root:dir,runtime:f.runtime,remote:f.remote,run:async packet=>{if(packet.args[0]==='install'&&!f.failRepair){f.calls.push(packet.args);for(const [name,body] of Object.entries(f.packageBefore??{}))await fs.writeFile(path.join(pkg,name),body);return;}return f.run(packet);}}).init();
 f.submit=async data=>{if(data.action!=='recover'){f.packageBefore=Object.fromEntries(await Promise.all(['package.json','cordis.patch.yml'].map(async name=>[name,await fs.readFile(path.join(pkg,name),'utf8')])));}return f.manager.submit({requestId:randomUUID(),expectedRevision:(await f.manager.list()).revision,trustedCode:true,...data});};
 try{await fn(f);cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.stack});}finally{await f.manager.close();}
 console.log(JSON.stringify(cases.at(-1)));
}
await test('Package target rejects tags, URLs, shell options and managed components',async()=>{for(const value of ['thing@latest','--help','https://example.com/package.tgz','git+https://example.com/x','dsh-become-human-web@1.0.0','@deepseek-ai/dsh@0.2.0','name@1.0.0 --force'])assert.throws(()=>extensionTarget(value));assert.equal(extensionTarget('@scope/human@1.2.3-beta.1').name,'@scope/human');});
await test('Archive input must really be a supported archive',()=>assert.throws(()=>archiveManifest(Buffer.from('not a tarball')),/ARCHIVE_INVALID/));
await test('Listing does not stop services and exposes only extension nodes',async f=>{const r=await f.manager.list();assert.equal(r.items.length,1);assert.equal(r.items[0].nodes[0].id,'human-extension.example');assert.equal(f.stops,0);});
await test('Standard DSH insert patch exposes the same managed extension nodes',async f=>{await fs.writeFile(path.join(f.pkg,'cordis.patch.yml'),'- insert:\n    - id: human-extension.example\n      name: dsh-human-example\n      config:\n        enabled: true\n');const r=await f.manager.list();assert(r.items[0].manageable);assert.equal(r.items[0].nodes[0].id,'human-extension.example');});
await test('Toggle preserves config, restarts once and restores original run state',async f=>{await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;const r=await f.manager.list();assert.equal(r.items[0].nodes[0].disabled,true);assert.deepEqual(r.items[0].nodes[0].config,{enabled:true});assert.equal(f.starts,1);assert.equal(f.resumes,1);assert.equal(r.jobs[0].status,'completed');});
await test('Paused runtime remains paused after a successful configuration change',async f=>{f.state.desired='paused';await f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'human-extension.example',config:{topics:['one','two']},disabled:false}]});await f.manager.active;assert.equal(f.resumes,0);assert.equal((await f.manager.list()).items[0].nodes[0].config.topics.length,2);});
await test('Stale revision and foreign configuration cannot mutate or restart',async f=>{await assert.rejects(()=>f.manager.submit({action:'toggle',name:'dsh-human-example',enabled:false,expectedRevision:'stale',requestId:randomUUID(),trustedCode:true}),/CONFIGURATION_CHANGED/);await assert.rejects(()=>f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'become-human',config:{}}]}));assert.equal(f.stops,0);});
await test('One request ID survives response loss and conflicts reject',async f=>{const input={action:'toggle',name:'dsh-human-example',enabled:false,requestId:randomUUID(),expectedRevision:(await f.manager.list()).revision,trustedCode:true};const first=await f.manager.submit(input);await f.manager.active;assert.equal((await f.manager.submit(input)).id,first.id);assert.equal(f.starts,1);await assert.rejects(()=>f.manager.submit({...input,enabled:true}),/REQUEST_ID_CONFLICT/);});
await test('Concurrent operations are serialized at admission and cannot overlap',async f=>{let done;f.runtime.start=()=>new Promise(r=>done=r);const initial=await f.manager.list();const a=f.manager.submit({requestId:randomUUID(),action:'toggle',name:'dsh-human-example',enabled:false,expectedRevision:initial.revision,trustedCode:true});const b=f.manager.submit({requestId:randomUUID(),action:'toggle',name:'dsh-human-example',enabled:true,expectedRevision:initial.revision,trustedCode:true});await a;await assert.rejects(()=>b,/OPERATION_BUSY/);while(!done)await new Promise(r=>setTimeout(r,5));done();await f.manager.active;});
await test('Failed startup keeps a visible failed record and never resumes models',async f=>{f.failStart=true;await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;assert.equal((await f.manager.list()).jobs[0].code,'WORKER_START_FAILED');assert.equal(f.resumes,0);assert.equal(f.state.desired,'paused');});
await test('Interrupted operation history is not automatically replayed on manager restart',async f=>{await fs.writeFile(f.manager.file,JSON.stringify([{id:'x',requestId:'interrupted',status:'running'}]));const next=await new RuntimeExtensions({root:f.dir,runtime:f.runtime,remote:f.remote,run:f.run}).init();assert.equal((await next.list()).jobs[0].status,'interrupted');assert.equal(f.calls.length,0);await next.close();});
await test('Protected package removal and untrusted installation are rejected',async f=>{await assert.rejects(()=>f.submit({action:'remove',name:'dsh-become-human-runtime'}));await assert.rejects(()=>f.manager.submit({requestId:randomUUID(),action:'install',source:'thing@1.0.0',trustedCode:false}));assert.equal(f.stops,0);});
await test('Unsupported bundle nodes cannot be configured as ordinary Human extensions',async f=>{await fs.writeFile(path.join(f.pkg,'cordis.patch.yml'),'- id: become-human\n  name: malicious\n');const r=await f.manager.list();assert.equal(r.items[0].manageable,false);assert.equal(r.items[0].code,'EXTENSION_NAMESPACE_REQUIRED');await assert.rejects(()=>f.submit({action:'toggle',name:'dsh-human-example',enabled:true}));assert.equal(f.stops,0);});
await test('Exact-version install disables scripts and preserves the existing package store',async f=>{
 await fs.writeFile(path.join(f.profile,'node_modules','.modules.yaml'),'storeDir: '+JSON.stringify(path.join(f.dir,'pnpm-store','v10'))+'\n');
 f.run=async packet=>{f.calls.push(packet.args);const m=JSON.parse(await fs.readFile(path.join(f.pkg,'package.json')));m.version='1.1.0';await fs.writeFile(path.join(f.pkg,'package.json'),JSON.stringify(m));};
 await f.submit({action:'install',source:'dsh-human-example@1.1.0'});await f.manager.active;const r=await f.manager.list();assert.equal(r.jobs[0].status,'completed');assert.equal(r.items[0].version,'1.1.0');assert(f.calls[0].includes('--ignore-scripts'));assert(f.calls[0].includes('--store-dir='+path.join(f.dir,'pnpm-store')));assert.equal(f.resumes,1);
});
await test('Rejected installed bundle restores the prior package and stays paused',async f=>{
 f.run=async()=>{await fs.writeFile(path.join(f.pkg,'cordis.patch.yml'),'- id: become-human\n  name: invalid\n');};await f.submit({action:'install',source:'dsh-human-example@1.0.0'});await f.manager.active;const r=await f.manager.list();assert.equal(r.jobs[0].code,'EXTENSION_NAMESPACE_REQUIRED');assert.equal(r.jobs[0].recovery.status,'restored');assert.equal(r.items[0].registered,true);assert.equal(f.starts,1);assert.equal(f.resumes,0);
});
await test('Removal cleans owned configuration and keeps unrelated nodes',async f=>{
 await fs.writeFile(path.join(f.profile,'human-extensions.patch.yml'),'- id: human-extension.example\n  config: {enabled: true}\n- id: human-extension.other\n  config: {value: keep}\n');await f.submit({action:'remove',name:'dsh-human-example'});await f.manager.active;const r=await f.manager.list();assert.equal(r.jobs[0].status,'completed');assert.equal(r.items.length,0);const c=await f.manager.configuration();assert.deepEqual(c.patch.map(p=>p.id),['human-extension.other']);assert.equal(f.resumes,1);
});
await test('Package manager failure restores locked dependencies without resuming models',async f=>{
 f.run=async()=>{throw Error('EXTENSION_CLI_FAILED');};await f.submit({action:'install',source:'dsh-human-example@1.0.0'});await f.manager.active;assert.equal((await f.manager.list()).jobs[0].code,'EXTENSION_CLI_FAILED');assert.equal(f.starts,1);assert.equal(f.resumes,0);assert.equal(f.manager.jobs[0].recovery.status,'restored');
});
await test('Existing autonomous failure is not cleared by a successful extension restart',async f=>{
 f.state.autonomy.paused=true;await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;assert.equal((await f.manager.list()).jobs[0].status,'completed');assert.equal(f.resumes,0);
});

const source={id:'fixture.source',title:'Public source',url:'https://example.com/feed',intervalMs:600000};
async function editorFixture(f,version=1){const p=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(p));m.dsh.human={configEditors:[{nodeId:'human-extension.example',kind:'public-sources',version}]};await fs.writeFile(p,JSON.stringify(m));}
await test('Editor metadata is package-independent and future editors retain advanced JSON',async f=>{
 await editorFixture(f);assert.equal((await f.manager.list()).items[0].configEditors[0].nodeId,'human-extension.example');await editorFixture(f,2);assert.equal((await f.manager.list()).items[0].configEditors.length,0);
});
await test('Foreign editor node cannot masquerade as an owned configuration form',async f=>{
 await editorFixture(f);const p=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(p));m.dsh.human.configEditors[0].nodeId='human-extension.foreign';await fs.writeFile(p,JSON.stringify(m));assert.equal((await f.manager.list()).items[0].code,'EXTENSION_EDITOR_INVALID');assert.equal(f.stops,0);
});
await test('Invalid source forms reject before stopping, recording a job or changing configuration',async f=>{
 await editorFixture(f);const before=await f.manager.configuration();
 for(const value of [{...source,url:'http://127.0.0.1/'},{...source,url:'https://example.com/?token=private'},{...source,url:'https://u:p@example.com/'},{...source,intervalMs:1000},{...source,enabled:'yes'},{...source,title:''}])await assert.rejects(()=>f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'human-extension.example',config:{sources:[value]}}]}));
 await assert.rejects(()=>f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'human-extension.example',config:{sources:[source,source]}}]}));
 assert.equal((await f.manager.configuration()).revision,before.revision);assert.equal(f.stops,0);assert.equal(f.manager.jobs.length,0);
});
await test('Source configuration preserves stable IDs, future top-level fields and paused runtime',async f=>{
 await editorFixture(f);f.state.desired='paused';const config={sources:[{...source,enabled:false}],reviewWithModel:false,customFuture:{keep:'yes'}};
 await f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'human-extension.example',disabled:false,config}]});await f.manager.active;assert.deepEqual((await f.manager.list()).items[0].nodes[0].config,config);assert.equal(f.stops,1);assert.equal(f.resumes,0);
});
await test('Rejected source config retains failure and restores the captured baseline',async f=>{
 await editorFixture(f);await fs.writeFile(path.join(f.pkg,'cordis.patch.yml'),'- id: human-extension.example\n  name: dsh-human-example\n  config:\n    sources:\n      - id: fixture.source\n        title: Private\n        url: http://127.0.0.1/\n');
 await f.submit({action:'install',source:'dsh-human-example@1.0.0'});await f.manager.active;assert.equal(f.manager.jobs[0].code,'SOURCE_URL_NOT_ALLOWED');assert.equal(f.manager.jobs[0].recovery.status,'restored');assert.equal(f.starts,1);
});
await test('Source status differentiates network, parse and queued content without claiming verification',async()=>{
 const {sourceStatusView}=await import('../plugins/become-human-web/extension-config.mjs');assert.equal(sourceStatusView(null,{enabled:false}).state,'disabled');assert.equal(sourceStatusView(null).state,'unavailable');assert.equal(sourceStatusView({checking:true}).state,'checking');assert.equal(sourceStatusView({lastError:'SOURCE_DNS_TIMEOUT'}).kind,'network');assert.equal(sourceStatusView({lastError:'SOURCE_FEED_INVALID'}).kind,'format');assert.match(sourceStatusView({lastSuccess:1,pendingItems:2}).hint,/不代表事实/);
});

await test('Malformed advanced JSON cannot bypass validation or crash the editor contract',async()=>{
 const {validateEditorEntries}=await import('../plugins/become-human-web/extension-config.mjs');for(const entries of [null,{},[null],[42]])assert.throws(()=>validateEditorEntries({configEditors:[]},entries),/EXTENSION_CONFIGURATION_INVALID/);
});
await test('Duplicate enabled source identities across owned nodes reject before restart',async f=>{
 const p=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(p));m.dsh.human={configEditors:['example','second'].map(id=>({nodeId:'human-extension.'+id,kind:'public-sources',version:1}))};await fs.writeFile(p,JSON.stringify(m));await fs.writeFile(path.join(f.pkg,'cordis.patch.yml'),'- id: human-extension.example\n  name: dsh-human-example\n- id: human-extension.second\n  name: dsh-human-example\n');
 await assert.rejects(()=>f.submit({action:'configure',name:'dsh-human-example',entries:['example','second'].map(id=>({id:'human-extension.'+id,config:{sources:[source]}}))}),/EXTENSION_SOURCE_ID_CONFLICT/);assert.equal(f.stops,0);
});
await test('Failed configuration restores exact previous override before starting paused',async f=>{
 const before=await f.manager.configuration();let first=true;f.runtime.start=async()=>{f.starts++;if(first){first=false;throw Error('WORKER_START_FAILED');}};
 await f.submit({action:'configure',name:'dsh-human-example',entries:[{id:'human-extension.example',config:{changed:true}}]});await f.manager.active;
 assert.equal(f.manager.jobs[0].code,'WORKER_START_FAILED');assert.equal(f.manager.jobs[0].recovery.status,'restored');assert.equal((await f.manager.configuration()).revision,before.revision);assert.equal(f.starts,2);assert.equal(f.resumes,0);assert.equal(f.manager.blocked,null);
 await assert.rejects(()=>fs.access(f.manager.recoveryStore.file(f.manager.jobs[0].id)),{code:'ENOENT'});
});
await test('Failed removal restores dependency and extension configuration',async f=>{
 let first=true;f.runtime.start=async()=>{f.starts++;if(first){first=false;throw Error('WORKER_START_FAILED');}};await f.submit({action:'remove',name:'dsh-human-example'});await f.manager.active;
 assert.equal(f.manager.jobs[0].recovery.status,'restored');assert.equal((await f.manager.list()).items[0].name,'dsh-human-example');assert.equal(f.resumes,0);
});
await test('Offline recovery failure stays held until an explicit idempotent retry',async f=>{
 f.failStart=true;await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;const original=f.manager.blocked;assert(original&&f.manager.canRecover(original));
 await assert.rejects(()=>f.submit({action:'toggle',name:'dsh-human-example',enabled:true}),/EXTENSION_RECOVERY_REQUIRED/);f.failStart=false;
 const input={action:'recover',operationId:original.id,expectedRevision:(await f.manager.list()).revision,requestId:randomUUID(),trustedCode:true};const job=await f.manager.submit(input);await f.manager.active;assert.equal(f.manager.jobs.at(-1).status,'completed');assert.equal(original.recovery.status,'restored');const starts=f.starts;assert.equal((await f.manager.submit(input)).id,job.id);assert.equal(f.starts,starts);assert.equal(f.resumes,0);
});
await test('Manual recovery refuses subsequent user configuration changes',async f=>{
 f.failStart=true;await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;const original=f.manager.blocked,stops=f.stops;
 await fs.writeFile(path.join(f.profile,'human-extensions.patch.yml'),'- id: human-extension.owner-change\n  config: {}\n');
 await assert.rejects(()=>f.submit({action:'recover',operationId:original.id}),/EXTENSION_RECOVERY_CONFLICT/);assert.equal(f.stops,stops);assert((await fs.readFile(path.join(f.profile,'human-extensions.patch.yml'),'utf8')).includes('owner-change'));
});
await test('Changed recovery snapshot is never used to overwrite profile files',async f=>{
 f.failStart=true;await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;const original=f.manager.blocked,before=(await f.manager.configuration()).revision;
 await fs.appendFile(f.manager.recoveryStore.file(original.id),' ');f.failStart=false;await f.submit({action:'recover',operationId:original.id});await f.manager.active;
 assert.equal(f.manager.jobs.at(-1).code,'EXTENSION_RECOVERY_CHANGED');assert.equal((await f.manager.configuration()).revision,before);assert(f.manager.blocked);
});
await test('Crash in package mutation blocks ordinary startup without automatic replay',async f=>{
 const id=randomUUID(),recovery=await f.manager.recoveryStore.capture(id,{packages:true,sessionId:'preserved-session'});recovery.status='mutating';f.manager.jobs.push({id,requestId:randomUUID(),name:'dsh-human-example',status:'running',action:'install',recovery});await f.manager.save();
 const next=await new RuntimeExtensions({root:f.dir,runtime:f.runtime,remote:f.remote,run:f.run}).init();assert(next.blocked);assert.equal(next.jobs.at(-1).status,'interrupted');assert.equal(next.canRecover(next.blocked),false);assert.equal(f.calls.length,0);assert.equal(f.starts,0);await next.close();
});
await test('Missing existing dependency lock refuses mutation without calling the package manager',async f=>{
 await fs.unlink(path.join(f.profile,'pnpm-lock.yaml'));await f.submit({action:'install',source:'dsh-human-example@1.1.0'});await f.manager.active;assert.equal(f.manager.jobs[0].code,'EXTENSION_RECOVERY_LOCK_REQUIRED');assert.equal(f.calls.length,0);assert.equal((await f.manager.list()).items[0].version,'1.0.0');
});
await test('Recovery does not restore a different human session or start autonomous thinking',async f=>{
 let first=true;f.runtime.close=async()=>{f.closed=true;};f.runtime.start=async()=>{if(first){first=false;throw Error('WORKER_START_FAILED');}f.state.sessionId='unexpected-session';};await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;assert.equal(f.manager.blocked.recovery.code,'STALE_SESSION');assert(f.closed);assert.equal(f.resumes,0);
});
await test('Unavailable runtime still pins recovery to the persisted session identity',async f=>{
 const identityDir=path.join(f.runtime.config.runtimeHome,'become-human');await fs.mkdir(identityDir);await fs.writeFile(path.join(identityDir,'agent.json'),JSON.stringify({sessionId:'preserved-session'}));let firstRead=true,firstStart=true;
 f.runtime.state=async()=>{if(firstRead){firstRead=false;throw Error('WORKER_UNAVAILABLE');}return f.state;};f.runtime.start=async()=>{if(firstStart){firstStart=false;throw Error('WORKER_START_FAILED');}f.state.sessionId='unexpected-session';};
 await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;assert.equal(f.manager.blocked.recovery.code,'STALE_SESSION');assert.equal(f.resumes,0);
});
await test('Downloaded replacement without a registered behavior fails and restores original package',async f=>{
 f.runtime.read=async()=>[];f.run=async packet=>{f.calls.push(packet.args);const file=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(file));m.dsh.human={replacesBehaviors:['reflect-experience']};await fs.writeFile(file,JSON.stringify(m));};
 await f.submit({action:'install',source:'dsh-human-example@1.0.0'});await f.manager.active;const job=f.manager.jobs[0];assert.equal(job.code,'EXTENSION_BEHAVIOR_REGISTRATION_FAILED');assert.equal(job.recovery.status,'restored');assert.equal(f.resumes,0);assert.deepEqual((await f.manager.list()).items[0].replacesBehaviors,[]);
});
await test('Disabled replacement must be absent from actual runtime catalog',async f=>{
 const file=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(file));m.dsh.human={replacesBehaviors:['reflect-experience']};await fs.writeFile(file,JSON.stringify(m));f.runtime.read=async()=>[{id:'reflect-experience'}];
 await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;const job=f.manager.jobs[0];assert.equal(job.code,'EXTENSION_BEHAVIOR_REGISTRATION_FAILED');assert.equal(job.recovery.status,'restored');assert.equal((await f.manager.list()).items[0].nodes[0].disabled,false);
});
await test('Disabled replacement commits when runtime catalog confirms absence',async f=>{
 const file=path.join(f.pkg,'package.json'),m=JSON.parse(await fs.readFile(file));m.dsh.human={replacesBehaviors:['reflect-experience']};await fs.writeFile(file,JSON.stringify(m));f.runtime.read=async()=>[];
 await f.submit({action:'toggle',name:'dsh-human-example',enabled:false});await f.manager.active;assert.equal(f.manager.jobs[0].status,'completed');assert.equal((await f.manager.list()).items[0].nodes[0].disabled,true);
});
const result={at:new Date().toISOString(),passed:cases.filter(x=>x.passed).length,failed:cases.filter(x=>!x.passed).length,cases,scope:'Isolated management and service lifecycle with stub package manager; no production package installation'};
if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed}));if(result.failed)process.exitCode=1;
