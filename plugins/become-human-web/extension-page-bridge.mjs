import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const fail=code=>{throw Error(code);},hash=value=>createHash('sha256').update(value).digest('hex');
const json=value=>{let result;try{result=JSON.stringify(value??null);}catch{fail('EXTENSION_RPC_INVALID_JSON');}if(Buffer.byteLength(result)>32768)fail('EXTENSION_RPC_TOO_LARGE');return result;};
export async function pageClientAsset(profile,page){
  const directory=path.join(profile,'node_modules',page.packageName),root=await fs.realpath(directory),file=path.resolve(directory,page.client),resolved=await fs.realpath(file);
  if(!file.startsWith(path.resolve(directory)+path.sep)||!resolved.startsWith(root+path.sep))fail('EXTENSION_CLIENT_PATH_INVALID');
  const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)fail('EXTENSION_CLIENT_INVALID');
  const bytes=await fs.readFile(file);if(bytes.length>1048576)fail('EXTENSION_CLIENT_INVALID');return {text:bytes.toString('utf8'),digest:hash(bytes)};
}
export class ExtensionPageBridge {
  constructor(extensions,runtime){this.extensions=extensions;this.runtime=runtime;this.tickets=new Map();}
  async catalog(){
    const source=await this.extensions.pages();let registered=[];
    if(source.pages.some(page=>page.version===2))registered=await this.runtime.read({kind:'extension-page-catalog'});
    const pages=await Promise.all(source.pages.map(async page=>{
      if(page.version!==2)return page;
      const rpc=registered.find(row=>row.key===page.key);
      const ready=!!rpc&&page.methods.every(m=>rpc.methods.some(r=>r.name===m.name&&r.mode===m.mode));
      try{const asset=await pageClientAsset(this.extensions.profile,page),fingerprint=hash(JSON.stringify([source.revision,page,asset.digest,rpc?.generation]));return {...page,assetDigest:asset.digest,fingerprint,moduleId:'human-page-'+fingerprint,ready,generation:rpc?.generation??null};}
      catch{return {...page,ready:false,error:'EXTENSION_CLIENT_INVALID'};}
    }));return {revision:source.revision,pages};
  }
  async resolve(input){
    if(this.extensions.active||this.extensions.blocked)fail('EXTENSION_OPERATION_BUSY');
    const page=(await this.catalog()).pages.find(page=>page.key===input.key);
    if(!page||page.version!==2)fail('EXTENSION_PAGE_UNAVAILABLE');
    if(!page.ready)fail(page.error??'EXTENSION_RPC_UNAVAILABLE');
    if(!input.fingerprint||input.fingerprint!==page.fingerprint)fail('EXTENSION_PAGE_STALE');
    return page;
  }
  async script(input){const page=await this.resolve(input),asset=await pageClientAsset(this.extensions.profile,page);
    // Re-resolve after reading bytes so a concurrent update cannot serve mixed versions.
    const latest=await this.resolve(input);if(latest.moduleId!==page.moduleId)fail('EXTENSION_PAGE_STALE');
    if(asset.digest!==page.assetDigest)fail('EXTENSION_PAGE_STALE');
    return `window.__ModuleLoader__.load({id:${JSON.stringify(page.moduleId)},factory:(require)=>{var module={exports:{}},exports=module.exports;\n${asset.text}\nreturn module.exports;}});\n`;
  }
  async validate(input,mode){
    const page=await this.resolve(input),method=page.methods.find(m=>m.name===input.method);if(!method||method.mode!==mode)fail('EXTENSION_RPC_METHOD_NOT_ALLOWED');
    const state=await this.runtime.state();if(!input.sessionId||state.sessionId!==input.sessionId)fail('STALE_SESSION');json(input.payload);return {page,method};
  }
  async prepare(input){
    const {page,method}=await this.validate(input,'write');for(const [id,t] of this.tickets)if(t.expires<Date.now())this.tickets.delete(id);if(this.tickets.size>=128)fail('EXTENSION_RPC_BUSY');
    const token=randomUUID(),requestId=randomUUID(),expires=Date.now()+60000,packet={sessionId:input.sessionId,key:page.key,method:method.name,payload:JSON.parse(json(input.payload)),fingerprint:page.fingerprint,requestId};
    this.tickets.set(token,{packet,expires,used:false});return {token,requestId,expires,title:page.title,method:method.name,description:method.description,payload:packet.payload};
  }
  async call(input,mode){
    const {page}=await this.validate(input,mode);let packet=input,ticket;
    if(mode==='write'){
      ticket=this.tickets.get(input.token);if(!ticket||ticket.expires<Date.now())fail('EXTENSION_RPC_APPROVAL_EXPIRED');
      packet=ticket.packet;if(['sessionId','key','method','fingerprint','requestId'].some(key=>packet[key]!==input[key])||json(packet.payload)!==json(input.payload))fail('EXTENSION_RPC_APPROVAL_MISMATCH');
      if(ticket.used){if(ticket.result)return ticket.result;fail('EXTENSION_RPC_RESULT_UNKNOWN');}ticket.used=true;
    }
    const result=await this.runtime.request('extension',{sessionId:input.sessionId,key:page.key,generation:page.generation,mode,method:packet.method,payload:packet.payload??null,requestId:packet.requestId??randomUUID()});
    // Never show late results from a removed, disabled or replaced extension.
    await this.resolve(input);if(ticket)ticket.result=result;return result;
  }
}
