import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {resolvePublicAddresses} from './public-dns.mjs';

// Open public web research. Domain and subject are not allowlisted. Every hop is
// pinned to a public DNS address; no browser cookies, credentials or JS execution.
export function researchUrl(value){
  if(typeof value!=='string'||value.length>2400)throw new Error('SOURCE_URL_NOT_ALLOWED');
  let u;try{u=new URL(value);}catch{throw new Error('SOURCE_URL_NOT_ALLOWED');}
  const host=u.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'').toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!host.includes('.')&&!net.isIP(host)||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||net.isIP(host)&&!publicAddress(host)||[...u.searchParams.keys()].some(k=>/^(?:access[_-]?token|token|api[_-]?key|password|secret|authorization|signature)$/i.test(k)))throw new Error('SOURCE_URL_NOT_ALLOWED');
  // Retain ordinary element IDs as local selection hints. Fragments are never
  // sent in HTTP requests; opaque payloads and text directives stay excluded.
  try{const fragment=decodeURIComponent(u.hash.slice(1));if(fragment.length>200||fragment&&!/^[\p{L}\p{N}_.:-]+$/u.test(fragment)||/sk-[\w-]{16,}/iu.test(fragment))u.hash='';}catch{u.hash='';}
  if(u.href.length>2400)throw new Error('SOURCE_URL_NOT_ALLOWED');return u.href;
}
export function publicAddress(address){
  if(net.isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2))||a===100&&b>=64&&b<=127||a>=224||a===198&&([18,19].includes(b)||b===51&&c===100)||a===203&&b===0&&c===113);}
  // Restrict IPv6 to global unicast. IPv4-mapped and local addresses are excluded.
  return net.isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:0{0,3}[0-9a-f]{1,2}|db8):|^2002:/i.test(address);
}
function decodeBody(chunks,type){try{return new TextDecoder(/charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]??'utf-8').decode(Buffer.concat(chunks));}catch{return Buffer.concat(chunks).toString('utf8');}}
const connectionRetryCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EADDRNOTAVAIL','ECONNABORTED','CONNECT_TIMEOUT']);
const connectionDiagnosticCodes=new Set([...connectionRetryCodes,'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']);
const connectionCode=error=>connectionDiagnosticCodes.has(error?.code)?error.code:'CONNECTION_ERROR';
const sourcePhases=new Set(['connection','response-headers','response-body','cancelled']);
const sourceCodes=new Set([...connectionDiagnosticCodes,'CONNECTION_ERROR','CANCELLED','READ_TIMEOUT','URL_NOT_ALLOWED','RATE_LIMITED','RESPONSE_UNSUPPORTED','RESPONSE_ERROR','RESPONSE_ABORTED']);
const dnsCodes=new Set(['SOURCE_DNS_FAILED','SOURCE_DNS_TIMEOUT','SOURCE_DNS_RESPONSE_INVALID','SOURCE_DNS_BODY_TOO_LARGE','SOURCE_ADDRESS_NOT_PUBLIC']);
// Explicitly clone only the bounded diagnostic contract. Never spread a free-
// form Error, DNS answer, URL or supplied request data into a persisted record.
export function sourceFailureDiagnostic(error){
  try{
    const value=error?.sourceDiagnostic;
    if(value?.version===2&&value.phase==='dns'&&dnsCodes.has(value.code)&&Number.isSafeInteger(value.elapsedMs)&&value.elapsedMs>=0&&value.elapsedMs<=20000)return {version:2,phase:'dns',code:value.code,elapsedMs:value.elapsedMs};
    if(!value||value.version!==1||!Array.isArray(value.attempts)||value.attempts.length<1||value.attempts.length>3)return null;
    const attempts=[];let candidateCount;
    for(const [index,row] of value.attempts.entries()){
      if(!row||!sourcePhases.has(row.phase)||!sourceCodes.has(row.code)||![4,6].includes(row.family)||!Number.isSafeInteger(row.elapsedMs)||row.elapsedMs<0||row.elapsedMs>20000||row.candidateIndex!==index+1||!Number.isSafeInteger(row.candidateCount)||row.candidateCount<1||row.candidateCount>3||row.candidateIndex>row.candidateCount||candidateCount!==undefined&&candidateCount!==row.candidateCount)return null;
      candidateCount=row.candidateCount;attempts.push({phase:row.phase,code:row.code,family:row.family,elapsedMs:row.elapsedMs,candidateIndex:row.candidateIndex,candidateCount:row.candidateCount});
    }
    return {version:1,attempts};
  }catch{return null;}
}
function addressCandidates(addresses){
  const unique=[...new Map(addresses.map(row=>[row.address,{address:row.address,family:net.isIP(row.address)}])).values()];
  // Give both address families a chance without performing another DNS lookup.
  const first=unique[0],other=unique.find(row=>row.family!==first.family);
  return [first,...(other?[other]:[]),...unique.filter(row=>row!==first&&row!==other)].slice(0,3);
}
function requestPinned(u,pinned,signal,sendRequest){
  return new Promise((resolve,reject)=>{
    let request,response,done=false,headers=false,total=0,connectionTimer;const chunks=[],started=Date.now();
    const complete=(error,value,{phase='connection',code='CONNECTION_ERROR',retryable=false}={})=>{
      if(done)return;done=true;clearTimeout(connectionTimer);signal.removeEventListener('abort',abort);
      if(error){error.connectionAttempt={phase,code,family:pinned.family,elapsedMs:Math.min(20000,Math.max(0,Date.now()-started))};error.retryableConnection=retryable&&!headers;request?.destroy();response?.destroy();reject(error);}else resolve(value);
    };
    const abort=()=>{const timed=signal.reason?.name==='TimeoutError';complete(new Error(timed?'SOURCE_TIMEOUT':'SOURCE_CANCELLED'),{},{phase:timed?(headers?'response-body':'response-headers'):'cancelled',code:timed?'READ_TIMEOUT':'CANCELLED'});};
    try{request=sendRequest(u,{method:'GET',agent:false,lookup:(_host,options,callback)=>options?.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family),headers:{'User-Agent':'BecomeHumanResearch/0.5','Accept':'text/html,text/plain,application/json,application/xml,application/rss+xml,application/atom+xml','Accept-Encoding':'identity'}},res=>{
      if(done){res.destroy();return;}response=res;headers=true;clearTimeout(connectionTimer);
      if([301,302,303,307,308].includes(res.statusCode)){let redirect;try{if(!res.headers.location)throw new Error();redirect=researchUrl(new URL(res.headers.location,u).href);}catch{complete(new Error('SOURCE_URL_NOT_ALLOWED'),null,{phase:'response-headers',code:'URL_NOT_ALLOWED'});return;}complete(null,{redirect});res.destroy();return;}
      const type=String(res.headers['content-type']??'').toLowerCase();
      if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||!['text/html','text/plain','text/markdown','text/xml','application/json','application/xml','application/rss+xml','application/atom+xml'].some(t=>type.startsWith(t))){complete(new Error(res.statusCode===429?'SOURCE_RATE_LIMITED':'SOURCE_RESPONSE_UNSUPPORTED'),null,{phase:'response-headers',code:res.statusCode===429?'RATE_LIMITED':'RESPONSE_UNSUPPORTED'});return;}
      res.on('data',chunk=>{if(done)return;const remaining=2097152-total;total+=chunk.length;if(total>2097152){if(remaining>0)chunks.push(chunk.subarray(0,remaining));complete(null,{type,body:decodeBody(chunks,type),truncated:true});request.destroy();res.destroy();}else chunks.push(chunk);});
      res.on('error',()=>complete(new Error('SOURCE_CONNECTION_FAILED'),null,{phase:'response-body',code:'RESPONSE_ERROR'}));
      res.on('aborted',()=>complete(new Error('SOURCE_CONNECTION_FAILED'),null,{phase:'response-body',code:'RESPONSE_ABORTED'}));
      res.on('end',()=>complete(null,{type,body:decodeBody(chunks,type),truncated:false}));
    });}catch(error){const code=connectionCode(error);complete(new Error('SOURCE_CONNECTION_FAILED'),null,{code,retryable:connectionRetryCodes.has(code)});return;}
    if(done){request?.destroy();return;}
    connectionTimer=setTimeout(()=>complete(new Error('SOURCE_CONNECTION_FAILED'),null,{code:'CONNECT_TIMEOUT',retryable:true}),4000);
    request.once('socket',socket=>{
      if(socket.encrypted)socket.once('secureConnect',()=>clearTimeout(connectionTimer));
      else if(socket.connecting)socket.once('connect',()=>clearTimeout(connectionTimer));
      else clearTimeout(connectionTimer);
    });
    const requestError=error=>{const code=connectionCode(error);complete(new Error('SOURCE_CONNECTION_FAILED'),null,{phase:headers?'response-body':'connection',code,retryable:connectionRetryCodes.has(code)});};
    signal.addEventListener('abort',abort,{once:true});request.on('error',requestError);
    if(signal.aborted){abort();return;}try{request.end();}catch(error){requestError(error);}
  });
}
async function requestText(url,signal,{resolveAddresses=resolvePublicAddresses,request:sendRequest}={}){
  signal.throwIfAborted();
  const u=new URL(researchUrl(url));
  const started=Date.now();let addresses;
  try{addresses=await resolveAddresses(u.hostname,{signal,isPublic:publicAddress});}
  catch(error){
    if(signal.aborted&&signal.reason?.name!=='TimeoutError')throw signal.reason??error;
    const code=signal.aborted?'SOURCE_DNS_TIMEOUT':dnsCodes.has(error?.message)?error.message:'SOURCE_DNS_FAILED';
    throw Object.assign(new Error(code),{sourceDiagnostic:{version:2,phase:'dns',code,elapsedMs:Math.min(20000,Math.max(0,Date.now()-started))}});
  }
  signal.throwIfAborted();
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(x=>!x||!publicAddress(x.address)))throw new Error('SOURCE_ADDRESS_NOT_PUBLIC');
  const candidates=addressCandidates(addresses),attempts=[];
  for(let index=0;index<candidates.length;index++){
    signal.throwIfAborted();
    try{return await requestPinned(u,candidates[index],signal,sendRequest??(u.protocol==='https:'?https:http).request);}
    catch(error){attempts.push({...error.connectionAttempt,candidateIndex:index+1,candidateCount:candidates.length});
      if(!signal.aborted&&error.retryableConnection&&index+1<candidates.length)continue;
      const failure=new Error(error.message);failure.sourceDiagnostic={version:1,attempts};throw failure;
    }
  }
}
// The third argument is dependency injection for isolated checks only. No
// runtime config, environment variable, tool input or public caller sets it.
export async function fetchPublicDocument(input,signal,dependencies){
  const combined=AbortSignal.any([signal,AbortSignal.timeout(20000)]);let url=researchUrl(input),result;
  try{for(let i=0;i<4;i++){result=await requestText(url,combined,dependencies);combined.throwIfAborted();if(!result.redirect)break;const next=new URL(result.redirect);if(!result.redirect.includes('#'))next.hash=new URL(url).hash;url=researchUrl(next.href);if(i===3)throw new Error('SOURCE_REDIRECT_LIMIT');}}
  catch(error){if(signal.aborted)throw signal.reason??error;if(combined.aborted)throw Object.assign(new Error('SOURCE_TIMEOUT'),error.sourceDiagnostic?{sourceDiagnostic:error.sourceDiagnostic}:{});if(['ENOTFOUND','EAI_AGAIN'].includes(error.code))throw new Error('SOURCE_DNS_FAILED');throw error;}
  return {...result,url,fetchedAt:Date.now()};
}
