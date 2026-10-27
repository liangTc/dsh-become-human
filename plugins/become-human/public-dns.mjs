import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import {domainToASCII} from 'node:url';

// Fake-IP DNS is common in local VPNs. Only that exact synthetic address range
// may use this resolver; private, mixed and literal synthetic targets stay denied.
// Resolver identity, bootstrap IP and format are fixed, never model/config/env
// inputs. The domestic fallback uses the public standard wire endpoint rather
// than assuming the provider's account-based JSON API has Google's contract.
const resolvers=Object.freeze([
  Object.freeze({hostname:'dns.google',address:'8.8.8.8',path:'/resolve',format:'json'}),
  Object.freeze({hostname:'dns.alidns.com',address:'223.5.5.5',path:'/dns-query',format:'wire'}),
  Object.freeze({hostname:'dns.alidns.com',address:'223.6.6.6',path:'/dns-query',format:'wire'}),
]);
const bodyLimit=65536;
const failure=code=>new Error(code);
const retryCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EADDRNOTAVAIL','ECONNABORTED','EPIPE']);
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
// RFC 1035 A/IN query, ID zero as recommended for DoH cacheability. The parser
// still verifies that ID and the complete question on every response.
export function publicDnsWireQuery(hostname){
  const name=domain(hostname),labels=name.split('.').map(label=>Buffer.from(label,'ascii')),header=Buffer.alloc(12);header.writeUInt16BE(0x0100,2);header.writeUInt16BE(1,4);
  return Buffer.concat([header,...labels.flatMap(label=>[Buffer.from([label.length]),label]),Buffer.from([0,0,1,0,1])]);
}
function wireName(body,start){
  let position=start,next=null,length=0;const labels=[],seen=new Set();
  for(let step=0;step<128;step++){
    if(position<12||position>=body.length||seen.has(position))throw failure('SOURCE_DNS_RESPONSE_INVALID');seen.add(position);
    const size=body[position];
    if((size&0xc0)===0xc0){
      if(position+1>=body.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');const target=((size&0x3f)<<8)|body[position+1];
      if(target<12||target>=position)throw failure('SOURCE_DNS_RESPONSE_INVALID');if(next===null)next=position+2;position=target;continue;
    }
    if(size&0xc0)throw failure('SOURCE_DNS_RESPONSE_INVALID');position++;
    if(size===0)return {name:labels.join('.'),next:next??position};
    if(size>63||position+size>body.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');const label=body.subarray(position,position+size);
    if(label.some(byte=>byte<33||byte>126))throw failure('SOURCE_DNS_RESPONSE_INVALID');length+=size+(labels.length?1:0);if(length>253)throw failure('SOURCE_DNS_RESPONSE_INVALID');
    labels.push(label.toString('ascii'));position+=size;
  }
  throw failure('SOURCE_DNS_RESPONSE_INVALID');
}
// Only the controlled resolver's response bytes reach this parser in runtime.
// Exported for isolated malformed-packet checks; no tool accepts raw packets.
export function publicDnsWireAnswer(body,hostname,isPublic){
  if(!Buffer.isBuffer(body)||body.length<12||body.length>bodyLimit||typeof isPublic!=='function')throw failure('SOURCE_DNS_RESPONSE_INVALID');
  const name=domain(hostname),flags=body.readUInt16BE(2),counts=[body.readUInt16BE(6),body.readUInt16BE(8),body.readUInt16BE(10)];
  if(body.readUInt16BE(0)!==0||!(flags&0x8000)||(flags&0x7800)||(flags&0x0200)||(flags&0x0040)||(flags&0x0010)||(flags&0x000f)||body.readUInt16BE(4)!==1||counts.reduce((n,v)=>n+v,0)>64)throw failure('SOURCE_DNS_RESPONSE_INVALID');
  const question=wireName(body,12);let position=question.next;
  if(domain(question.name)!==name||position+4>body.length||body.readUInt16BE(position)!==1||body.readUInt16BE(position+2)!==1)throw failure('SOURCE_DNS_RESPONSE_INVALID');position+=4;
  const aliases=new Map(),answers=[];
  for(let section=0;section<counts.length;section++)for(let index=0;index<counts[section];index++){
    const owner=wireName(body,position);position=owner.next;
    if(position+10>body.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');const type=body.readUInt16BE(position),recordClass=body.readUInt16BE(position+2),size=body.readUInt16BE(position+8);position+=10;const end=position+size;
    if(end>body.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');
    if(type===1||type===28){
      if(recordClass!==1||size!==(type===1?4:16))throw failure('SOURCE_DNS_RESPONSE_INVALID');
      const address=type===1?[...body.subarray(position,end)].join('.'):Array.from({length:8},(_,i)=>body.readUInt16BE(position+i*2).toString(16)).join(':');
      // Reject nonpublic answers in *every* section, even unrelated glue.
      if(!isPublic(address))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');const recordName=domain(owner.name);
      if(section===0&&type===1)answers.push({name:recordName,address,family:4});
    }else if(type===5){
      if(recordClass!==1)throw failure('SOURCE_DNS_RESPONSE_INVALID');const target=wireName(body,position);if(target.next!==end)throw failure('SOURCE_DNS_RESPONSE_INVALID');
      const sourceName=domain(owner.name),targetName=domain(target.name);
      if(section===0){if(aliases.has(sourceName)&&aliases.get(sourceName)!==targetName)throw failure('SOURCE_DNS_RESPONSE_INVALID');aliases.set(sourceName,targetName);}
    }
    position=end;
  }
  if(position!==body.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');
  const chain=new Set();let target=name;
  while(aliases.has(target)){if(chain.has(target))throw failure('SOURCE_DNS_RESPONSE_INVALID');chain.add(target);target=aliases.get(target);}
  const addresses=answers.filter(answer=>answer.name===target).map(({address,family})=>({address,family}));
  if(!addresses.length)throw failure('SOURCE_DNS_RESPONSE_INVALID');return [...new Map(addresses.map(answer=>[answer.address,answer])).values()];
}
async function dohEndpoint(hostname,signal,isPublic,request,resolver){
  const timeout=AbortSignal.timeout(2500),combined=AbortSignal.any([signal,timeout]);
  combined.throwIfAborted();
  const path=resolver.format==='wire'?`${resolver.path}?dns=${publicDnsWireQuery(hostname).toString('base64url')}`:`${resolver.path}?${new URLSearchParams({name:hostname,type:'A',cd:'0',edns_client_subnet:'0.0.0.0/0'})}`;
  try{return await new Promise((resolve,reject)=>{
    let response,finished=false,total=0,headers=false;const chunks=[];
    const complete=(error,value)=>{if(finished)return;finished=true;combined.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const stop=error=>{complete(error);response?.destroy();req?.destroy();};
    const endpointError=(code,retryable=false)=>Object.assign(failure(code),{dnsRetryable:retryable&&!headers});
    const abort=()=>stop(signal.aborted?signal.reason??failure('SOURCE_CANCELLED'):endpointError('SOURCE_DNS_TIMEOUT',true));
    let req;
    try{req=request({protocol:'https:',hostname:resolver.hostname,port:443,path,method:'GET',agent:false,servername:resolver.hostname,lookup:(_host,options,callback)=>options?.all?callback(null,[{address:resolver.address,family:4}]):callback(null,resolver.address,4),headers:{Accept:resolver.format==='wire'?'application/dns-message':'application/json','Accept-Encoding':'identity','User-Agent':'BecomeHumanResearch/0.5'}},res=>{
      if(finished){res.destroy();return;}response=res;headers=true;
      // No redirects, credentials, cookies, compression or unbounded responses.
      const validType=resolver.format==='wire'?/^application\/dns-message(?:\s*;|$)/iu:/^application\/(?:dns-)?json(?:\s*;|$)/iu;
      if(res.statusCode!==200||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||!validType.test(String(res.headers['content-type']??''))){stop(failure('SOURCE_DNS_RESPONSE_INVALID'));return;}
      res.on('data',chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;if(total>bodyLimit){stop(failure('SOURCE_DNS_BODY_TOO_LARGE'));return;}chunks.push(bytes);});
      res.on('error',()=>stop(failure('SOURCE_DNS_FAILED')));
      res.on('end',()=>{if(finished)return;try{const body=Buffer.concat(chunks);complete(null,resolver.format==='wire'?publicDnsWireAnswer(body,hostname,isPublic):validateAnswer(JSON.parse(body.toString('utf8')),hostname,isPublic));}catch(error){stop(/^SOURCE_[A-Z_]+$/u.test(error?.message??'')?error:failure('SOURCE_DNS_RESPONSE_INVALID'));}});
      res.on('aborted',()=>stop(failure('SOURCE_DNS_FAILED')));
    });}catch(error){complete(endpointError('SOURCE_DNS_FAILED',retryCodes.has(error?.code)));return;}
    combined.addEventListener('abort',abort,{once:true});
    const requestError=error=>stop(signal.aborted?signal.reason??failure('SOURCE_CANCELLED'):timeout.aborted?endpointError('SOURCE_DNS_TIMEOUT',true):endpointError('SOURCE_DNS_FAILED',retryCodes.has(error?.code)));
    req.on('error',requestError);try{req.end();}catch(error){requestError(error);}
    if(combined.aborted)abort();
  });}catch(error){if(signal.aborted)throw signal.reason??failure('SOURCE_CANCELLED');throw error;}
}
// Dependencies are injectable for isolated transport checks. Production callers
// supply only the signal and the existing public-address predicate.
export async function resolvePublicAddresses(hostname,{signal,isPublic,lookup=dns.lookup,request=https.request}={}){
  if(!signal||typeof isPublic!=='function')throw failure('SOURCE_DNS_CONFIGURATION_INVALID');
  const timeout=AbortSignal.timeout(8000),combined=AbortSignal.any([signal,timeout]);
  try{
    combined.throwIfAborted();const host=String(hostname).replace(/^\[|\]$/gu,'');
    if(net.isIP(host)){if(!isPublic(host))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');return [{address:host,family:net.isIP(host)}];}
    const name=domain(host),addresses=await systemLookup(name,combined,lookup);combined.throwIfAborted();
    if(!Array.isArray(addresses)||!addresses.length)throw failure('SOURCE_ADDRESS_NOT_PUBLIC');
    if(addresses.every(answer=>answer&&typeof answer.address==='string'&&net.isIP(answer.address)&&isPublic(answer.address)))return addresses.map(answer=>({address:answer.address,family:net.isIP(answer.address)}));
    if(!addresses.every(answer=>answer&&fakeAddress(answer.address)))throw failure('SOURCE_ADDRESS_NOT_PUBLIC');
    let last;
    for(const resolver of resolvers){try{return await dohEndpoint(name,combined,isPublic,request,resolver);}catch(error){combined.throwIfAborted();if(!error.dnsRetryable)throw error;last=error;}}
    throw last??failure('SOURCE_DNS_FAILED');
  }catch(error){if(signal.aborted)throw signal.reason??failure('SOURCE_CANCELLED');if(timeout.aborted)throw failure('SOURCE_DNS_TIMEOUT');throw error;}
}
