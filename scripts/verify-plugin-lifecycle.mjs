import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
registerHooks({resolve(name,context,next){try{return next(name,context);}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND'||name.startsWith('.')||name.includes(':'))throw e;return next(name,{...context,parentURL:pathToFileURL(path.resolve('plugins/become-human-web/manager.mjs')).href});}}});
const {ControlJournal}=await import('../plugins/become-human/driver.mjs');
const {PluginEvents}=await import('../plugins/become-human/plugin-events.mjs');
const {HumanPlugins,pluginResourceId}=await import('../plugins/become-human/plugin-lifecycle.mjs');
const {BehaviorRegistry}=await import('../plugins/become-human/behaviors.mjs');
const {LearningPack}=await import('../plugins/become-human/learning-pack.mjs');
const {ExtensionPageRpc}=await import('../plugins/become-human/extension-page-rpc.mjs');
const {apply}=await import('../plugins/become-human/behavior-packs/learning/index.mjs');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'human-lifecycle-')),cases=[];
const schema={type:'object',properties:{topic:{type:'string'}},required:['topic'],additionalProperties:false};
const base={version:1,title:'测试行为包',events:[{id:'tick',descriptor:{version:1,title:'考虑一次活动',inputSchema:schema}}]};
async function test(name,fn){const id=crypto.randomUUID(),j=new ControlJournal(path.join(root,id+'.sqlite'));j.ensure(id);j.set(id,'running');let now=Date.now(),wakes=0;const f={journal:j,controllerSessionId:id,autonomy:{settings:()=>({enabled:true})},behaviors:new BehaviorRegistry(),learningPack:new LearningPack()};f.pluginEvents=new PluginEvents(j,{agentId:()=>id,now:()=>now,wake:()=>wakes++});const plugins=new HumanPlugins(f,{now:()=>now}),pages=new ExtensionPageRpc(j,()=>id);plugins.pages=pages;const x={id,j,f,plugins,pages,get now(){return now;},advance:ms=>now+=ms,get wakes(){return wakes;}};try{await fn(x);cases.push({name,passed:true});}catch(e){cases.push({name,passed:false,error:e.stack});}finally{plugins.close();pages.close();j.close();}console.log(JSON.stringify(cases.at(-1)));}
await test('Atomic registration rolls back pages, events and schedules on later failure',x=>{assert.throws(()=>x.plugins.register('test',{...base,pages:[{id:'main',handlers:{read:{mode:'read',handle:()=>null}}}],schedules:[{id:'bad',source:'missing',title:'错误定时',rule:{kind:'every',seconds:60}}]}));assert.equal(x.pages.catalog().length,0);assert.equal(x.f.pluginEvents.sources.size,0);assert.equal(x.plugins.catalog().length,0);assert.equal(x.j.db.prepare('SELECT count(*) n FROM human_plugin_schedule').get().n,0);});
await test('Scoped names coexist and dispose only their own registrations',x=>{const a=x.plugins.register('@demo/a',base),b=x.plugins.register('@demo/b',base);assert.notEqual(pluginResourceId('@demo/a','tick'),pluginResourceId('@demo/b','tick'));a.dispose();assert.equal(x.f.pluginEvents.sources.size,1);assert.throws(()=>a.publish('tick',{}),/DISPOSED/);assert.throws(()=>x.plugins.register('@demo/b',base),/REGISTRATION/);b.dispose();assert.equal(x.f.pluginEvents.sources.size,0);});
await test('Managed timer emits once, survives re-registration and coalesces downtime',async x=>{const d={...base,schedules:[{id:'period',source:'tick',title:'检查一次',rule:{kind:'every',seconds:60},payload:{topic:'考虑是否行动'}}]};let p=x.plugins.register('test',d);x.advance(60001);x.plugins.pump();await Promise.resolve();assert.equal(x.f.pluginEvents.status(x.id).pending,1);assert.equal(x.wakes,1);x.plugins.pump();assert.equal(x.wakes,1);const next=x.plugins.catalog()[0].schedules[0].nextAt;p.dispose();x.advance(5*60000);x.plugins.pump();assert.equal(x.f.pluginEvents.status(x.id).pending,1);p=x.plugins.register('test',d);assert.equal(x.plugins.catalog()[0].schedules[0].nextAt,next);x.plugins.pump();await Promise.resolve();assert.equal(x.f.pluginEvents.status(x.id).pending,2);assert(x.plugins.catalog()[0].schedules[0].nextAt>x.now);p.dispose();});
await test('Global pause and autonomy protection block timer emission',x=>{x.plugins.register('test',{...base,schedules:[{id:'once',source:'tick',title:'一次活动',rule:{kind:'after',seconds:60},payload:{topic:'测试'}}]});x.advance(61000);x.j.set(x.id,'paused');x.plugins.pump();assert.equal(x.f.pluginEvents.status(x.id).pending,0);x.j.set(x.id,'running');x.j.put(x.id,'autonomyPaused',true);x.plugins.pump();assert.equal(x.f.pluginEvents.status(x.id).pending,0);x.j.put(x.id,'autonomyPaused',false);x.plugins.pump();assert.equal(x.f.pluginEvents.status(x.id).pending,1);assert.equal(x.plugins.catalog()[0].schedules[0].status,'completed');});
await test('All lifecycle phases receive committed records, restart does not replay them',x=>{const got=[],hooks=Object.fromEntries(['input','selection','result','feedback','memory','growth','delivery'].map(phase=>[phase,e=>{got.push(phase);return {state:{last:e.id}};}]));const d={...base,hooks};let p=x.plugins.register('test',d);for(const kind of ['conversation-input-published','activity-result','event-feedback','memory-saved','persona-development-applied','response-published'])x.j.audit(x.id,kind,{});x.plugins.selection({id:'select-1',phase:'selection'});assert.deepEqual(got,['input','result','feedback','memory','growth','delivery','selection']);p.dispose();p=x.plugins.register('test',d);x.plugins.pump();assert.equal(got.length,7);});
await test('Hook failure rolls back contributions, isolates phase and never blocks Human',x=>{x.plugins.register('test',{...base,hooks:{feedback:()=>{throw Error('private failure');},memory:()=>({state:{ok:true}})}});x.j.audit(x.id,'event-feedback',{});x.j.audit(x.id,'memory-saved',{});x.plugins.pump();assert.deepEqual(x.plugins.catalog()[0].held,['feedback']);assert.deepEqual(x.j.value(x.id,'plugin-state:test',{}),{ok:true});assert.equal(x.j.get(x.id).desired,'running');});
await test('Async hooks are rejected, and uncommitted event publications cannot wake execution',async x=>{x.plugins.register('test',{...base,hooks:{selection:async()=>({state:{bad:true}})}});x.plugins.selection({id:'one'});assert.deepEqual(x.plugins.catalog()[0].held,['selection']);assert.throws(()=>x.j.transaction(()=>{x.f.pluginEvents.sources.size;const handle=x.f.pluginEvents.register('rollback',{version:1,title:'回滚',inputSchema:schema});handle.publish({key:'x',occurredAt:x.now,expiresAt:x.now+60000,payload:{topic:'x'}});throw Error('rollback');}));await Promise.resolve();assert.equal(x.wakes,0);});
await test('Existing learning package registers its workflow and actual page as one owner',x=>{let dispose;apply({humanLearning:{contractVersion:1,read:()=>({oldNotesRetained:true}),write:()=>({saved:true})},humanPlugins:x.plugins.service(),effect:fn=>{dispose=fn();}});assert.equal(x.f.learningPack.catalog().length,1);assert.equal(x.pages.catalog()[0].key,'dsh-human-learning:learning');assert.deepEqual(x.plugins.catalog()[0].hooks,['result','feedback']);dispose();assert.equal(x.f.learningPack.catalog().length,0);assert.equal(x.pages.catalog().length,0);});
await test('Quiet hours suppress scheduled publication; latest coalesces and all retains the durable cursor',async x=>{
 const minute=60000,evening=Date.UTC(2030,0,1,21,59);
 x.advance(evening-x.now);x.f.autonomy.settings=()=>({enabled:true,quietStart:22,quietEnd:8,timeZoneOffsetMinutes:0});
 const schedule={id:'latest',source:'tick',title:'定时活动',rule:{kind:'every',seconds:60},payload:{topic:'回顾'}};
 assert.throws(()=>x.plugins.register('invalid',{...base,schedules:[{...schedule,missedPolicy:'unknown'}]}),/PLUGIN_SCHEDULE_INVALID/);
 const descriptor={...base,schedules:[schedule,{...schedule,id:'each',missedPolicy:'all'}]};
 const p=x.plugins.register('test',descriptor);
 for(let i=0;i<601;i++){x.advance(minute);if(i===600)break;x.plugins.pump();}
 assert.equal(x.wakes,0);assert.equal(x.f.pluginEvents.status(x.id).pending,0);
 x.plugins.pump();await Promise.resolve();assert.equal(x.f.pluginEvents.status(x.id).pending,2);
 const times=scheduleId=>x.j.db.prepare("SELECT json_extract(data,'$.occurredAt') AS at FROM human_plugin_event WHERE event_key LIKE ? ORDER BY at").all('schedule:'+scheduleId+':%').map(r=>r.at);
 assert.deepEqual(times('latest'),[x.now]);assert.deepEqual(times('each'),[evening+minute]);
 p.dispose();x.plugins.register('test',descriptor);x.plugins.pump();
 assert.deepEqual(times('latest'),[x.now]);assert.deepEqual(times('each'),[evening+minute,evening+2*minute]);
});
await test('Congested plugin clock retries once capacity returns, including a pre-upgrade held schedule',x=>{
 const schedule={id:'once',source:'tick',title:'一次活动',rule:{kind:'after',seconds:60},payload:{topic:'测试'}};
 const descriptor={...base,schedules:[schedule]},p=x.plugins.register('test',descriptor);
 for(let i=0;i<64;i++)p.publish('tick',{key:'other:'+i,occurredAt:x.now,expiresAt:x.now+3600000,payload:{topic:'other'}});
 x.advance(60000);x.plugins.pump();
 let current=x.plugins.catalog()[0].schedules[0];assert.equal(current.status,'pending');assert.equal(current.error,'PLUGIN_EVENT_QUEUE_FULL');assert.equal(current.nextAt,x.now+60000);
 const sourceId=x.f.pluginEvents.events(x.id,{limit:1})[0].id;
 x.f.pluginEvents.claim(x.id,[sourceId]);x.plugins.pump();assert.equal(x.plugins.catalog()[0].schedules[0].status,'pending');
 x.advance(60000);x.plugins.pump();assert.equal(x.plugins.catalog()[0].schedules[0].status,'completed');
 assert.equal(x.j.db.prepare("SELECT count(*) n FROM human_plugin_event WHERE event_key LIKE 'schedule:%'").get().n,1);
 p.dispose();
 // Simulate the held state previously written for another due one-shot.
 const next={...descriptor,schedules:[{...schedule,id:'old'}]};const old=x.plugins.register('test',next);x.advance(60000);old.dispose();
 x.j.db.prepare("UPDATE human_plugin_schedule SET status='held',error='PLUGIN_EVENT_QUEUE_FULL' WHERE id='old'").run();
 x.advance(3600000);x.plugins.register('test',next);x.plugins.pump();
 current=x.plugins.catalog()[0].schedules[0];assert.equal(current.status,'completed');assert.equal(current.error,null);
});
console.log(JSON.stringify({passed:cases.filter(c=>c.passed).length,total:cases.length}));if(cases.some(c=>!c.passed))process.exitCode=1;
