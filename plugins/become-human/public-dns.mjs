import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import {domainToASCII} from 'node:url';

// Fake-IP DNS is common in local VPNs. Only that exact synthetic address range
// may use this resolver; private, mixed and literal synthetic targets stay denied.
// The resolver identity, transport IP and path are code constants, never input.
const resolver=Object.freeze({hostname:'dns.google',address:'8.8.8.8',path:'/resolve'});
const bodyLimit=65536;
const failure=code=>new Error(code);
function domain(value){
  const result=domainToASCII(String(value)).replace(/\.$/u,'').toLowerCase();
  if(!result||result.length>253||!result.split('.').every(label=>label.length>=1&&label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)))throw failure('SOURCE_DNS_RESPONSE_INVALID');
  return result;
}
function fakeAddress(value){if(net.isIP(value)!==4)return false;const [a,b]=value.split('.').map(Number);return a===198&&(b===18||b===19);}
async function systemLookup(hostname,signal,lookup){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason??failure('SOURCE_CANCELLED'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>lookup(hostname,{all:true})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}
function validateAnswer(value,hostname,isPublic){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.Status!==0||value.TC!==false||value.CD!==false||!Array.isArray(value.Question)||value.Question.length!==1||value.Question[0]?.type!==1||domain(value.Question[0]?.name)!==hostname||!Array.isArray(value.Answer)||!value.Answer.length||value.Answer.length>64)throw failure('SOURCE_DNS_RESPONSE_INVALID');
  const ips=value.Answer.filter(answer=>answer?.type===1||answer?.type===28);
  if(!ips.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');
  // Reject every nonpublic IP answer, even if an unrelated name occurs in it.
  if(ips.some(answer=>typeof answer.data!=='string'||net.isIP(answer.data)!==(answer.type===1?4:6)||!isPublic(answer.data)))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');
  const aliases=new Set([hostname]),cnames=value.Answer.filter(answer=>answer?.type===5);
  for(let pass=0;pass<=cnames.length;pass++){
    let changed=false;
    for(const answer of cnames){const name=domain(answer.name),target=domain(answer.data);if(aliases.has(name)&&!aliases.has(target)){aliases.add(target);changed=true;}}
    if(!changed)break;
  }
  const addresses=ips.filter(answer=>answer.type===1&&aliases.has(domain(answer.name))).map(answer=>({address:answer.data,family:4}));
  if(!addresses.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');
  return [...new Map(addresses.map(answer=>[answer.address,answer])).values()];
}
async function dohLookup(hostname,signal,isPublic,request){
  const timeout=AbortSignal.timeout(8000),combined=AbortSignal.any([signal,timeout]);
  combined.throwIfAborted();
  const path=`${resolver.path}?${new URLSearchParams({name:hostname,type:'A',cd:'0',edns_client_subnet:'0.0.0.0/0'})}`;
  try{return await new Promise((resolve,reject)=>{
    let response,finished=false,total=0;const chunks=[];
    const complete=(error,value)=>{if(finished)return;finished=true;combined.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const stop=error=>{complete(error);response?.destroy();req?.destroy();};
    const abort=()=>stop(signal.aborted?signal.reason??failure('SOURCE_CANCELLED'):failure('SOURCE_DNS_TIMEOUT'));
    let req;
    try{req=request({protocol:'https:',hostname:resolver.hostname,port:443,path,method:'GET',agent:false,servername:resolver.hostname,lookup:(_host,options,callback)=>options?.all?callback(null,[{address:resolver.address,family:4}]):callback(null,resolver.address,4),headers:{Accept:'application/json','Accept-Encoding':'identity','User-Agent':'BecomeHumanResearch/0.5'}},res=>{
      response=res;
      // No redirects, credentials, cookies, compression or unbounded responses.
      if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||!/^application\/(?:dns-)?json(?:\s*;|$)/iu.test(String(res.headers['content-type']??''))){stop(failure('SOURCE_DNS_RESPONSE_INVALID'));return;}
      res.on('data',chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;if(total>bodyLimit){stop(failure('SOURCE_DNS_BODY_TOO_LARGE'));return;}chunks.push(bytes);});
      res.on('error',()=>complete(failure('SOURCE_DNS_FAILED')));
      res.on('end',()=>{if(finished)return;try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));complete(null,validateAnswer(value,hostname,isPublic));}catch(error){complete(/^SOURCE_[A-Z_]+$/u.test(error?.message??'')?error:failure('SOURCE_DNS_RESPONSE_INVALID'));}});
      res.on('aborted',()=>complete(failure('SOURCE_DNS_FAILED')));
    });}catch{complete(failure('SOURCE_DNS_FAILED'));return;}
    combined.addEventListener('abort',abort,{once:true});
    req.on('error',()=>complete(signal.aborted?signal.reason??failure('SOURCE_CANCELLED'):timeout.aborted?failure('SOURCE_DNS_TIMEOUT'):failure('SOURCE_DNS_FAILED')));
    req.end();
    if(combined.aborted)abort();
  });}catch(error){if(signal.aborted)throw signal.reason??failure('SOURCE_CANCELLED');throw error;}
}
// Dependencies are injectable for isolated transport checks. Production callers
// supply only the signal and the existing public-address predicate.
export async function resolvePublicAddresses(hostname,{signal,isPublic,lookup=dns.lookup,request=https.request}={}){
  if(!signal||typeof isPublic!=='function')throw failure('SOURCE_DNS_CONFIGURATION_INVALID');
  signal.throwIfAborted();
  const host=String(hostname).replace(/^\[|\]$/gu,'');
  if(net.isIP(host)){if(!isPublic(host))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');return [{address:host,family:net.isIP(host)}];}
  const name=domain(host),addresses=await systemLookup(name,signal,lookup);signal.throwIfAborted();
  if(!Array.isArray(addresses)||!addresses.length)throw failure('SOURCE_ADDRESS_NOT_PUBLIC');
  if(addresses.every(answer=>answer&&typeof answer.address==='string'&&net.isIP(answer.address)&&isPublic(answer.address)))return addresses.map(answer=>({address:answer.address,family:net.isIP(answer.address)}));
  if(!addresses.every(answer=>answer&&fakeAddress(answer.address)))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');
  return dohLookup(name,signal,isPublic,request);
}
