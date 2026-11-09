import assert from 'node:assert/strict';
import http from 'node:http';
import {workerRequest} from '../plugins/become-human-web/worker-request.mjs';
const checks=[];
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const ok=()=>Response.json({items:[]}),base={base:'http://127.0.0.1:1',cookie:'synthetic',sameWorker:()=>true};
await check('Catalog connection reset retries once and records recovery',async()=>{let calls=0;const failures=[];let recovered=0;await workerRequest({...base,resource:'read',body:{kind:'behavior-catalog'},fetcher:async()=>{if(++calls===1)throw new TypeError('fetch failed');return ok();},onFailure:f=>failures.push(f),onRecovered:()=>recovered++});assert.equal(calls,2);assert.equal(failures[0].code,'WORKER_CONNECTION_FAILED');assert.equal(recovered,1);});
await check('Persistent catalog timeout is bounded and has an actionable error',async()=>{let calls=0;const keep=setInterval(()=>{},100);try{await assert.rejects(()=>workerRequest({...base,resource:'read',body:{kind:'workflow-catalog'},timeoutMs:5,fetcher:async(_url,{signal})=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),/WORKER_REQUEST_TIMEOUT/);assert.equal(calls,2);}finally{clearInterval(keep);}});
await check('Response body timeout is diagnosed, not reported as invalid JSON',async()=>{let calls=0;const keep=setInterval(()=>{},100);try{await assert.rejects(()=>workerRequest({...base,resource:'state',timeoutMs:5,fetcher:async(_url,{signal})=>{calls++;return {text:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};}}),/WORKER_REQUEST_TIMEOUT/);assert.equal(calls,2);}finally{clearInterval(keep);}});
await check('Lost control response never repeats the committed mutation',async()=>{let calls=0;await assert.rejects(()=>workerRequest({...base,resource:'control',body:{op:'pause'},fetcher:async()=>{calls++;throw new TypeError('fetch failed');}}),/WORKER_CONNECTION_FAILED/);assert.equal(calls,1);});
await check('Other reads are not implicitly considered retry safe',async()=>{let calls=0;await assert.rejects(()=>workerRequest({...base,resource:'read',body:{kind:'multimodal-status'},fetcher:async()=>{calls++;throw new TypeError('fetch failed');}}));assert.equal(calls,1);});
await check('Invalid JSON and stale session are not retried',async()=>{for(const response of [()=>new Response('invalid'),()=>Response.json({error:'STALE_SESSION'},{status:400})]){let calls=0;await assert.rejects(()=>workerRequest({...base,resource:'state',fetcher:async()=>{calls++;return response();}}));assert.equal(calls,1);}});
await check('Worker replacement prevents replay against a different process',async()=>{let current=true,calls=0;await assert.rejects(()=>workerRequest({...base,sameWorker:()=>current,resource:'state',fetcher:async()=>{calls++;current=false;throw new TypeError('fetch failed');}}));assert.equal(calls,1);});
await check('Late success from replaced worker is discarded',async()=>{let current=true;await assert.rejects(()=>workerRequest({...base,sameWorker:()=>current,resource:'state',fetcher:async()=>{current=false;return ok();}}),/WORKER_UNAVAILABLE/);});
const requests=[];
const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;
  requests.push({path:req.url,body});
  if(req.url.endsWith('/control')||requests.length===1){req.socket.destroy();return;}
  res.setHeader('Content-Type','application/json');res.end('{"items":[]}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const live={...base,base:'http://127.0.0.1:'+server.address().port};
  await check('Real HTTP connection loss during catalog read recovers on the same endpoint',async()=>{assert.deepEqual(await workerRequest({...live,resource:'read',body:{kind:'behavior-catalog'}}),{items:[]});assert.equal(requests.length,2);});
  await check('Real HTTP lost control response is delivered once only',async()=>{await assert.rejects(()=>workerRequest({...live,resource:'control',body:{op:'synthetic-control'}}),/WORKER_CONNECTION_FAILED/);assert.equal(requests.filter(r=>r.path.endsWith('/control')).length,1);});
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
console.log(JSON.stringify({passed:checks.length,failed:0}));
