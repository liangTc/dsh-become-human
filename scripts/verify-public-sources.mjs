import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {PublicSources} from '../plugins/become-human/public-sources.mjs';
import {fetchPublicDocument,sourceFailureDiagnostic} from '../plugins/become-human/public-document.mjs';
import {pageMetadata} from '../plugins/become-human/public-text.mjs';
const anchor=process.env.BH_TEST_DEPENDENCY_ANCHOR??path.resolve('plugins/become-human-web/manager.mjs');
registerHooks({resolve(name,ctx,next){try{return next(name,ctx);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...ctx,parentURL:pathToFileURL(anchor).href});}}});
const {ControlJournal}=await import('../plugins/become-human/driver.mjs');
const {PluginEvents}=await import('../plugins/become-human/plugin-events.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'human-public-source-')),cases=[];
const config={url:'https://example.com/feed',title:'External feed',intervalMs:60000};
async function test(name,fn){
 const file=path.join(root,randomUUID()+'.sqlite'),f={id:randomUUID(),now:Date.now(),calls:0,body:'Original public content',file};
 f.j=new ControlJournal(file);f.j.ensure(f.id);f.events=new PluginEvents(f.j,{agentId:()=>f.id,now:()=>f.now});
 f.fetch=async url=>{f.calls++;return {url,body:f.body,type:'text/plain',truncated:false};};
 f.create=()=>new PublicSources(f.j,f.events,{agentId:()=>f.id,now:()=>f.now,fetch:(...args)=>f.fetch(...args)});
 f.s=f.create();f.register=(change={})=>f.s.register('fixture.public',{...config,...change});f.rows=()=>f.j.db.prepare('SELECT * FROM human_plugin_event').all();
 try{await fn(f);cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.stack});}finally{await f.s.close();f.j.close();}
 console.log(JSON.stringify(cases.at(-1)));
}
await test('Registration rejects credentials, private URLs, short frequency and implicit extra options',f=>{for(const c of [{url:'http://127.0.0.1/'},{url:'https://u:p@example.com/'},{url:'https://example.com/?token=secret'},{intervalMs:1000},{headers:{Cookie:'private'}},{emitInitial:'yes'}])assert.throws(()=>f.register(c));assert.equal(f.calls,0);});
await test('Shared source extraction retains entity-decoded titles and publisher-reported dates',()=>{const r=pageMetadata('<title>One &amp; Two</title><meta property="article:published_time" content="2026-11-01T08:00:00&#43;08:00">','text/html');assert.equal(r.title,'One & Two');assert.equal(r.publishedAt,'2026-11-01T00:00:00.000Z');assert.equal(r.publishedAtStatus,'publisher-reported');});
await test('First observation establishes a quiet baseline; same document consumes no event or model',async f=>{const h=f.register();assert.equal((await h.check()).state,'baseline');f.now+=60000;assert.equal((await h.check()).state,'unchanged');assert.equal(f.rows().length,0);assert.equal(f.calls,2);});
await test('Changed response creates one untrusted event with original and final URL and fingerprints',async f=>{const h=f.register();await h.check();f.now+=60000;f.body='Changed external material';const r=await h.check();assert.equal(r.state,'published');const event=h.get(r.eventId);assert(event.data.untrusted);assert.equal(event.data.payload.verified,false);assert(event.data.payload.previousDigest);assert.equal(event.data.payload.preview,f.body);assert.equal((await h.check()).state,'deferred');assert.equal(f.calls,2);assert.equal(f.rows().length,1);});
await test('Explicit initial emission and bounded preview are available without research notes',async f=>{f.body='材料。'.repeat(10000);const h=f.register({emitInitial:true});await h.check();const p=JSON.parse(f.rows()[0].data).payload;assert(p.previewTruncated);assert(Buffer.byteLength(JSON.stringify(p))<=7000);assert.equal(p.previousDigest,'');});
await test('Concurrent checks share one request and one event',async f=>{let release;f.fetch=async url=>{f.calls++;await new Promise(r=>release=r);return {url,body:f.body,type:'text/plain'};};const h=f.register({emitInitial:true}),a=h.check(),b=h.check();release();assert.deepEqual(await a,await b);assert.equal(f.calls,1);assert.equal(f.rows().length,1);});
await test('Restart retains baseline and unchanged content is not re-emitted',async f=>{const h=f.register({emitInitial:true});await h.check();await f.s.close();f.j.close();f.j=new ControlJournal(f.file);f.events=new PluginEvents(f.j,{agentId:()=>f.id,now:()=>f.now});f.s=f.create();const n=f.register({emitInitial:true});f.now+=60000;assert.equal((await n.check()).state,'unchanged');assert.equal(f.rows().length,1);});
await test('A to B to A produces distinct changes instead of colliding on a body hash',async f=>{const h=f.register({emitInitial:true});await h.check();f.now+=60000;f.body='B';await h.check();f.now+=60000;f.body='Original public content';await h.check();assert.equal(f.rows().length,3);assert.equal(new Set(f.rows().map(r=>r.event_key)).size,3);});
await test('Failed reads retain previous baseline, back off and do not emit failure as content',async f=>{const h=f.register();await h.check();f.now+=60000;f.fetch=async()=>{f.calls++;throw Error('SOURCE_CONNECTION_FAILED');};assert.equal((await h.check()).state,'failed');const t=h.status().nextAt;assert.equal(t,f.now+120000);assert.equal((await h.check()).state,'deferred');f.now=t;await h.check();assert.equal(h.status().nextAt,f.now+240000);assert.equal(f.rows().length,0);assert(h.status().initialized);});
await test('Private exception text is not stored in diagnostics or audits',async f=>{const h=f.register();f.fetch=async()=>{throw Error('cookie=do-not-persist');};await h.check();assert.equal(h.status().lastError,'SOURCE_CHECK_FAILED');assert(!JSON.stringify(f.j.db.prepare('SELECT * FROM audit').all()).includes('do-not-persist'));});
await test('Truncated bodies never become authoritative baselines or changes',async f=>{const h=f.register({emitInitial:true});f.fetch=async url=>({url,body:'partial',type:'text/plain',truncated:true});await h.check();assert.equal(h.status().lastError,'SOURCE_BODY_TRUNCATED');assert.equal(h.status().initialized,false);assert.equal(f.rows().length,0);});
await test('Disposal during a slow read prevents stale publication and state updates',async f=>{let release;f.fetch=url=>new Promise(resolve=>release=()=>resolve({url,body:f.body,type:'text/plain'}));const h=f.register({emitInitial:true}),p=h.check();h.dispose();release();await assert.rejects(p,/SOURCE_REMOVED/);assert.equal(f.rows().length,0);assert.equal(f.j.value(f.id,'publicSource:fixture.public',null),null);});
await test('Changing URL invalidates old events even if adapter source name stays the same',async f=>{const h=f.register({emitInitial:true}),r=await h.check();assert(f.events.valid(f.id,[r.eventId]));h.dispose();f.register({url:'https://example.org/feed',emitInitial:true});assert.equal(f.events.valid(f.id,[r.eventId]),false);});
await test('Queue full retains exact publication across restart without fetching again',async f=>{const original=f.events.publish.bind(f.events);f.events.publish=()=>{throw Error('PLUGIN_EVENT_QUEUE_FULL');};const h=f.register({emitInitial:true});await h.check();const pending=structuredClone(f.j.value(f.id,'publicSource:fixture.public',null).pending);assert(pending);const next=h.status().nextAt;await f.s.close();f.events.publish=original;f.s=f.create();const n=f.register({emitInitial:true});f.now=next;const r=await n.check();assert.equal(r.state,'published');assert.equal(f.calls,1);assert.equal(f.rows()[0].event_key,pending.key);assert.equal(JSON.parse(f.rows()[0].data).occurredAt,pending.occurredAt);});
await test('Crash after event commit replays same envelope once and then advances baseline',async f=>{const publish=f.events.publish.bind(f.events);let once=true;f.events.publish=(...args)=>{const r=publish(...args);if(once){once=false;throw Error('SIMULATED_CRASH_AFTER_COMMIT');}return r;};const h=f.register({emitInitial:true});await h.check();assert.equal(f.rows().length,1);f.now=h.status().nextAt;const r=await h.check();assert(r.duplicate);assert.equal(f.rows().length,1);assert.equal(f.calls,1);assert.equal(h.status().pendingPublication,false);});
await test('Close aborts in-flight readers before storage can close',async f=>{f.fetch=(_url,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));const h=f.register({emitInitial:true}),p=h.check();await f.s.close();await assert.rejects(p);assert.equal(f.rows().length,0);});
await test('Unknown IDs or schema changes cannot authorize arbitrary addresses',f=>{assert.throws(()=>f.register({url:'file:///etc/passwd'}));assert.throws(()=>f.register({url:'https://example.com:8443/'}));assert.equal(f.events.sources.size,0);});
await test('DNS failure diagnostic is bounded and strips arbitrary exception data',async()=>{const resolveAddresses=async()=>{throw Object.assign(Error('SOURCE_DNS_RESPONSE_INVALID'),{private:'do-not-store'});};let error;try{await fetchPublicDocument(config.url,new AbortController().signal,{resolveAddresses});}catch(e){error=e;}assert.deepEqual(Object.keys(sourceFailureDiagnostic(error)),['version','phase','code','elapsedMs']);assert.equal(sourceFailureDiagnostic(error).phase,'dns');assert(!JSON.stringify(error).includes('do-not-store'));});
await test('Pre-aborted caller never reaches transport',async()=>{let calls=0;const a=new AbortController();a.abort(Error('OWNER_CANCELLED'));await assert.rejects(()=>fetchPublicDocument(config.url,a.signal,{resolveAddresses:async()=>{calls++;return [];}}),/OWNER_CANCELLED/);assert.equal(calls,0);});
await test('Private redirect is rejected without issuing a second request',async()=>{let calls=0;const request=(_u,_o,cb)=>{calls++;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.headers={location:'http://127.0.0.1/private'};res.statusCode=302;res.destroy=()=>{};cb(res);};return req;};await assert.rejects(()=>fetchPublicDocument(config.url,new AbortController().signal,{resolveAddresses:async()=>[{address:'8.8.8.8',family:4}],request}),/SOURCE_URL_NOT_ALLOWED/);assert.equal(calls,1);});
await test('Reader timeout distinguishes response headers from response body and owner cancellation',async()=>{
 const original=AbortSignal.timeout;AbortSignal.timeout=()=>original.call(AbortSignal,15);const keep=setTimeout(()=>{},1000);
 try{for(const headers of [false,true]){const request=(_u,_o,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{if(headers){const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/plain'};res.destroy=()=>{};cb(res);}};return req;};let error;try{await fetchPublicDocument(config.url,new AbortController().signal,{resolveAddresses:async()=>[{address:'8.8.8.8',family:4}],request});}catch(e){error=e;}assert.equal(error.message,'SOURCE_TIMEOUT');const diagnostic=sourceFailureDiagnostic(error);assert.equal(diagnostic.attempts[0].code,'READ_TIMEOUT');assert.equal(diagnostic.attempts[0].phase,headers?'response-body':'response-headers');}}
 finally{AbortSignal.timeout=original;clearTimeout(keep);}
});
await test('Installed adapter offers a non-learning behavior and disposes both services',async f=>{
 const {apply}=await import('../docs/examples/human-public-source-plugin/index.mjs'),{BehaviorRegistry}=await import('../plugins/become-human/behaviors.mjs');const registry=new BehaviorRegistry();let cleanup;
 apply({humanSources:f.s,humanBehaviors:registry,effect:fn=>cleanup=fn()},{sources:[{id:'fixture.public',...config,emitInitial:true}]});
 await f.s.tick();const opportunities=registry.opportunities({id:f.id,factory:{journal:f.j}},{events:f.events.events(f.id)});assert.equal(opportunities.length,1);assert(opportunities[0].eventIds.length===1);assert.equal(f.rows().length,1);
 cleanup();assert.equal(registry.providers.size,0);assert.equal(f.s.status().length,0);assert.equal(f.events.events(f.id).length,0);
});

await test('Manual check has no model lane, coalesces and persists cooldown across restart',async f=>{
 const h=f.register();await h.check();assert.throws(()=>f.s.requestCheck('fixture.public','stale'),/SOURCE_CONFIGURATION_CHANGED/);
 let release;f.fetch=async url=>{f.calls++;await new Promise(r=>release=r);return {url,body:f.body,type:'text/plain'};};
 assert.equal(f.s.requestCheck('fixture.public',h.status().fingerprint).state,'queued');assert.equal(f.s.requestCheck('fixture.public',h.status().fingerprint).state,'checking');release();await f.s.tickJob;assert.equal(f.calls,2);assert.equal(f.rows().length,0);
 assert.throws(()=>f.s.requestCheck('fixture.public',h.status().fingerprint),/SOURCE_CHECK_TOO_SOON/);await f.s.close();f.s=f.create();const next=f.register();assert.throws(()=>f.s.requestCheck('fixture.public',next.status().fingerprint),/SOURCE_CHECK_TOO_SOON/);assert.equal(next.status().manualCheckAvailableAt,f.now+60000);
 next.dispose();assert.throws(()=>f.s.requestCheck('fixture.public','stale'),/SOURCE_NOT_REGISTERED/);
});
await test('Three bounded parallel readers prevent a slow first source blocking the rest',async f=>{
 let release,active=0,max=0,done=[];f.fetch=async url=>{active++;max=Math.max(max,active);if(url.endsWith('/0'))await new Promise(r=>release=r);else await new Promise(r=>setImmediate(r));active--;done.push(url);return {url,body:'Public',type:'text/plain'};};
 for(let i=0;i<7;i++)f.s.register('fixture.'+i,{...config,url:'https://example.com/'+i});
 const tick=f.s.tick();while(done.length<6)await new Promise(r=>setImmediate(r));assert(!done.includes('https://example.com/0'));assert.equal(max,3);release();await tick;assert.equal(done.length,7);
});
await test('Source removal and close abort parallel readers without late publication',async f=>{
 f.fetch=(_url,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 for(let i=0;i<5;i++)f.s.register('fixture.'+i,{...config,emitInitial:true});const tick=f.s.tick();assert.equal(f.s.jobs.size,3);await f.s.close();await tick;assert.equal(f.rows().length,0);
});
await test('Per-source disable keeps other sources active; reenable preserves baseline',async f=>{
 const {apply}=await import('../docs/examples/human-public-source-plugin/index.mjs');let cleanup;
 const ctx={humanSources:f.s,humanBehaviors:{register:()=>()=>{}},effect:fn=>cleanup=fn()};const rows=[{id:'fixture.enabled',...config},{id:'fixture.disabled',...config,enabled:false}];
 apply(ctx,{sources:rows});await f.s.tick();assert.equal(f.s.status().length,1);assert.equal(f.calls,1);cleanup();
 apply(ctx,{sources:rows.map(r=>({...r,enabled:false}))});await f.s.tick();assert.equal(f.calls,1);cleanup();
 apply(ctx,{sources:rows});f.now+=60000;await f.s.tick();assert.equal(f.calls,2);assert.equal(f.rows().length,0);assert(f.s.status()[0].initialized);cleanup();
});
await test('History capacity errors preserve last successful read and grow failure backoff',async f=>{
 const h=f.register({format:'feed'});f.fetch=async url=>({url,type:'application/feed+json',body:JSON.stringify({version:'https://jsonfeed.org/version/1.1',title:'Feed',items:[{id:'new',content_text:'New'}]})});
 const key='publicSource:fixture.public',fingerprint=h.status().fingerprint,items=Object.fromEntries(Array.from({length:4096},(_,i)=>['old'+i,'digest']));
 f.j.put(f.id,key,{fingerprint,digest:'previous',sequence:0,items,lastSuccess:123,nextAt:0,failures:2});const result=await h.check();assert.equal(result.code,'SOURCE_FEED_HISTORY_FULL');assert.equal(h.status().lastSuccess,123);assert.equal(h.status().failures,3);assert.equal(h.status().nextAt,f.now+480000);
});

const result={at:new Date().toISOString(),passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,scope:'Isolated persistent event collection and transport contracts; synthetic network responses, no real model or production state'};
if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,failed:result.failed}));if(result.failed)process.exitCode=1;
