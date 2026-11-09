import assert from 'node:assert/strict';
import {saveConfiguration} from '../plugins/become-human-web/configuration-save.mjs';
import {extensionPages,activeExtensionPages} from '../plugins/become-human-web/extension-pages.mjs';
const cases=[];
async function check(name,fn){await fn();cases.push(name);}
function fixture(patch={}){
 const state={sessionId:'same-session',desired:'running',driveMode:'continuous',cancelEpoch:7,agentBusy:false,autonomy:{paused:false},management:{revision:3},...patch},calls=[];
 const runtime={state:async()=>structuredClone(state),control:async command=>{calls.push(command.op);if(command.op==='pause'){state.desired='paused';state.cancelEpoch++;}else if(command.op==='start'){assert.equal(command.expectedEpoch,state.cancelEpoch);state.desired='running';}else state.management.revision++;}};
 const remote={maintenance:false,queueControl:fn=>fn(),blockWake:reason=>calls.push(reason)};
 return {state,calls,runtime,remote,input:{sessionId:state.sessionId,command:{op:'profile-save',expectedRevision:3}}};
}
await check('Running configuration resumes the same session',async()=>{const f=fixture();await saveConfiguration(f);assert.deepEqual(f.calls,['pause','profile-save','start']);assert.equal(f.state.desired,'running');assert.equal(f.remote.maintenance,false);});
await check('User-paused run stays paused',async()=>{const f=fixture({desired:'paused'});await saveConfiguration(f);assert.deepEqual(f.calls,['profile-save']);});
await check('Autonomy protection is retained',async()=>{const f=fixture({autonomy:{paused:true}});await saveConfiguration(f);assert.equal(f.state.autonomy.paused,true);});
await check('Busy execution is not interrupted',async()=>{const f=fixture({agentBusy:true});await assert.rejects(()=>saveConfiguration(f),/AGENT_BUSY/);assert.deepEqual(f.calls,[]);});
await check('Stale revision is rejected before pausing',async()=>{const f=fixture();f.input.command.expectedRevision=2;await assert.rejects(()=>saveConfiguration(f),/STALE_CONFIGURATION/);assert.deepEqual(f.calls,[]);});
await check('Stale session is rejected before pausing',async()=>{const f=fixture();f.input.sessionId='other';await assert.rejects(()=>saveConfiguration(f),/STALE_SESSION/);assert.deepEqual(f.calls,[]);});
await check('Dangerous operations cannot enter configuration save',async()=>{const f=fixture();f.input.command.op='session-delete-confirm';await assert.rejects(()=>saveConfiguration(f),/INVALID_CONFIGURATION_OPERATION/);assert.deepEqual(f.calls,[]);});
await check('Uncertain save failure does not restart',async()=>{const f=fixture(),control=f.runtime.control;f.runtime.control=async c=>{if(c.op==='profile-save')throw Error('WORKER_UNAVAILABLE');return control(c);};await assert.rejects(()=>saveConfiguration(f),/WORKER_UNAVAILABLE/);assert.equal(f.state.desired,'paused');assert.equal(f.remote.maintenance,false);assert(!f.calls.includes('start'));});
await check('Changed epoch cannot be resumed',async()=>{const f=fixture(),control=f.runtime.control;f.runtime.control=async c=>{await control(c);if(c.op==='profile-save')f.state.cancelEpoch++;};await assert.rejects(()=>saveConfiguration(f),/NOT_RESUMED/);assert(!f.calls.includes('start'));});
await check('Bounded manual runs are not turned into continuous runs',async()=>{const f=fixture({driveMode:'bounded'});await assert.rejects(()=>saveConfiguration(f),/PAUSE_REQUIRED/);assert.deepEqual(f.calls,[]);});
const nodes=[{id:'human-extension.example',disabled:false}],page={id:'overview',version:1,nodeId:nodes[0].id,title:'Example',blocks:[{type:'text',text:'Hello'},{type:'list',items:['one']},{type:'runtime-status'}]},manifest={name:'example',dsh:{human:{pages:[page]}}};
await check('Page declarations are validated and namespaced',()=>{const pages=extensionPages(manifest,nodes);const result=activeExtensionPages([{name:'example',version:'1',manageable:true,registered:true,nodes,pages}]);assert.equal(result[0].key,'example:overview');});
await check('Disabled and removed extensions expose no pages',()=>{const pages=extensionPages(manifest,nodes);assert.deepEqual(activeExtensionPages([{name:'example',manageable:true,registered:true,nodes:[{...nodes[0],disabled:true}],pages}]),[]);assert.deepEqual(activeExtensionPages([]),[]);assert.deepEqual(activeExtensionPages([{name:'example',manageable:false,registered:false,nodes,pages}]),[]);});
await check('Scripts, foreign nodes, duplicates and oversized declarations reject',()=>{for(const pages of [[{...page,blocks:[{type:'html',text:'<script/>'}]}],[{...page,nodeId:'host.core'}],[page,page],[{...page,title:'x'.repeat(65)}]])assert.throws(()=>extensionPages({dsh:{human:{pages}}},nodes),/EXTENSION_PAGE_INVALID/);});
console.log(JSON.stringify({passed:cases.length,cases},null,2));
