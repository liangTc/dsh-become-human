import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as wait} from 'node:timers/promises';
import {SingleImIngress} from '../plugins/become-human-web/im-ingress.mjs';
import {WeixinController} from '../plugins/become-human-web/im/src/channels/weixin/weixin-controller.mjs';
import {WeixinRuntime} from '../plugins/become-human-web/im/src/channels/weixin/weixin-runtime.mjs';
import {WeixinApiError} from '../plugins/become-human-web/im/src/channels/weixin/weixin-api.mjs';
import {ConnectionSupervisor} from '../plugins/become-human-web/im/plugin-src/host/channels/weixin/connection-supervisor.mjs';

const logger={info(){},warn(){},error(){},debug(){}};
const config={botId:'test-bot',accountId:'test-account',tokenRef:'test-ref',ownerUserId:'test-owner',baseUrl:'https://example.invalid'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await wait(5);}throw Error('condition not reached');};
function controllerFixture(createRuntime,credentials={resolve:async()=>({value:'synthetic-token'}),set:async()=>{},unset:async()=>{}}){
  const configs=new Map([[config.botId,config]]);
  const controller=new WeixinController({api:{beginLogin(){},pollLogin(){}},credentials,configStore:{list:()=>[...configs.values()],get:id=>configs.get(id),save:async x=>configs.set(x.botId,x),remove:async id=>configs.delete(id)},createRuntime,logger});
  return {controller,configs};
}
function runtimeStub(gate){
  let status={ready:false,weixinConnectionState:'idle',harnessReachable:true},starts=0,stops=0;
  return {get status(){return status;},get counts(){return {starts,stops};},async start(){starts++;await gate?.promise;status={ready:true,weixinConnectionState:'connected',harnessReachable:true};},async stop(){stops++;status.ready=false;}};
}
function runtimeFixture({failures=0,fatal,pollRetryDelaysMs=[1],startGate}={}){
  let polls=0,starts=0,stops=0,sends=0;
  const api={async notifyStart(){starts++;await startGate?.promise;},async notifyStop(){stops++;},async sendText(){sends++;return {ret:0};},async getUpdates({signal}){
    polls++;
    if(fatal)throw fatal;
    if(polls<=failures)throw new WeixinApiError(polls%2?'network-error':'http-error','synthetic outage',{status:503});
    if(polls===failures+1)return {ret:0,msgs:[]};
    return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }};
  const state={getUpdatesBuf:()=>'',bindContextTokens:async()=>{}};
  const runtime=new WeixinRuntime({api,config,token:'synthetic-token',harness:{ensureRunning:async()=>{},singleSessionIngress:{}},state,logger,startRetryDelaysMs:[],pollRetryDelaysMs});
  return {runtime,counts:()=>({polls,starts,stops,sends})};
}

test('shared health reads identity once for concurrent channels and never builds full state',async()=>{
  const db=new DatabaseSync(':memory:'),gate=deferred();let reads=0;
  const ingress=new SingleImIngress({db,register(){}},{state(){throw Error('FULL_SNAPSHOT_FORBIDDEN');},async read(input){reads++;assert.deepEqual(input,{kind:'identity'});await gate.promise;return {sessionId:'unique-test'};}});
  try{const pending=Array.from({length:13},(_,i)=>ingress.apiProxy.host.describe({rpcId:String(i)}));await until(()=>reads===1);gate.resolve();for(const r of await Promise.all(pending)){assert.equal(r.result.ok,true);assert.equal(r.result.value.ready,true);}await ingress.apiProxy.host.describe({rpcId:'next'});assert.equal(reads,2);}finally{db.close();}
});
test('health reports unavailable rather than policy denial and never caches a failure',async()=>{
  const db=new DatabaseSync(':memory:');let failed=true;
  const ingress=new SingleImIngress({db,register(){}},{read(){if(failed)throw Error('WORKER_UNAVAILABLE');return {sessionId:'unique-test'};}});
  try{const r=await ingress.apiProxy.host.describe({rpcId:'first'});assert.equal(r.result.error.code,'WORKER_UNAVAILABLE');assert(!r.result.error.message.includes('统一会话管理'));failed=false;assert.equal((await ingress.apiProxy.host.describe({rpcId:'second'})).result.ok,true);}finally{db.close();}
});
test('queued automatic restore does not stop a successful manual reconnect',async()=>{
  const gate=deferred();let created=0;const instances=[];
  const {controller}=controllerFixture(async()=>{created++;const runtime=runtimeStub(gate);instances.push(runtime);return runtime;});
  try{const manual=controller.reconnectBot(config.botId);await until(()=>created===1);const automatic=controller.initialize();gate.resolve();await Promise.all([manual,automatic]);assert.equal(created,1);assert.equal(instances[0].counts.stops,0);assert.equal(controller.status().totals.connected,1);}finally{await controller.close();}
});
test('double-click reconnect shares one transition; a later explicit reconnect remains possible',async()=>{
  const gate=deferred();let created=0;
  const {controller}=controllerFixture(async()=>{created++;return runtimeStub(gate);});
  try{const a=controller.reconnectBot(config.botId),b=controller.reconnectBot(config.botId);gate.resolve();await Promise.all([a,b]);assert.equal(created,1);await controller.reconnectBot(config.botId);assert.equal(created,2);}finally{await controller.close();}
});
test('transient poll failures beyond three recover without recreating runtime or sending messages',async()=>{
  const fixture=runtimeFixture({failures:5});let creates=0;
  const {controller}=controllerFixture(async()=>{creates++;return fixture.runtime;});
  try{await controller.initialize();await until(()=>fixture.runtime.status.weixinConnectionState==='reconnecting');await controller.initialize();assert.equal(creates,1);await until(()=>fixture.runtime.status.ready);assert.deepEqual(fixture.counts(),{polls:7,starts:1,stops:0,sends:0});assert.equal(controller.status().totals.connected,1);}finally{await controller.close();}
});
test('closing during retry cancels backoff and prevents later polls',async()=>{
  const fixture=runtimeFixture({failures:100,pollRetryDelaysMs:[10000]});await fixture.runtime.start();await until(()=>fixture.runtime.status.weixinConnectionState==='reconnecting');const before=fixture.counts().polls;await fixture.runtime.stop();await wait(10);assert.equal(fixture.counts().polls,before);assert.equal(fixture.runtime.status.ready,false);
});
test('invalid login token requires intervention and is not repeatedly restored',async()=>{
  const fixture=runtimeFixture({fatal:new WeixinApiError('stale-token','synthetic expired',{providerCode:'-14'})});let creates=0;
  const {controller}=controllerFixture(async()=>{creates++;return fixture.runtime;});
  try{await controller.initialize();await until(()=>fixture.runtime.status.weixinConnectionState==='failed');await controller.initialize();await controller.initialize();assert.equal(creates,1);assert.equal(fixture.counts().polls,1);assert(controller.status().bots[0].health.summary.includes('重新扫码'));}finally{await controller.close();}
});
test('missing credential is not busy-retried; explicit reconnect retries credential resolution',async()=>{
  let resolutions=0,available=false;
  const {controller}=controllerFixture(async()=>runtimeStub(),{async resolve(){resolutions++;return available?{value:'synthetic-token'}:null;},async set(){},async unset(){}});
  try{await controller.initialize();await controller.initialize();assert.equal(resolutions,1);available=true;await controller.reconnectBot(config.botId);assert.equal(resolutions,2);assert.equal(controller.status().totals.connected,1);}finally{await controller.close();}
});
test('supervisor restores without redundant host snapshot checks and retries initial failure',async()=>{
  let attempts=0,closed=false;const supervisor=new ConnectionSupervisor({controller:{status:()=>({totals:{configured:1,connected:0}}),async initialize(){attempts++;return {totals:{configured:1,connected:attempts>1?1:0}};}},harness:{ensureRunning(){throw Error('REDUNDANT_HOST_PROBE');}},retryDelaysMs:[1],healthyIntervalMs:10000,logger}).start();
  try{await until(()=>attempts===2);await supervisor.close();closed=true;const n=attempts;await wait(10);assert.equal(attempts,n);}finally{if(!closed)await supervisor.close();}
});
test('close waits for pending reconnect and disposes the resulting runtime',async()=>{
  const gate=deferred(),runtime=runtimeStub(gate);const {controller}=controllerFixture(async()=>runtime);
  const pending=controller.reconnectBot(config.botId);await until(()=>runtime.counts.starts===1);const closing=controller.close();gate.resolve();await Promise.all([pending,closing]);assert.equal(runtime.counts.stops,1);assert.equal(controller.status().totals.connected,0);await assert.rejects(()=>controller.reconnectBot(config.botId),/closed/);
});
