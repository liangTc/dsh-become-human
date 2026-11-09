import {createHash,randomUUID} from 'node:crypto';
const name=value=>typeof value==='string'&&/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,120}$/.test(value);
const method=value=>typeof value==='string'&&/^[a-z][a-z0-9.-]{0,63}$/.test(value);
const fail=code=>{throw Error(code);};
export function pageJson(value,limit=32768){
  let text;try{text=JSON.stringify(value);}catch{fail('EXTENSION_RPC_INVALID_JSON');}
  if(text===undefined||Buffer.byteLength(text)>limit)fail('EXTENSION_RPC_TOO_LARGE');
  return JSON.parse(text);
}
export class ExtensionPageRpc {
  constructor(journal,getSession,{timeoutMs=10000}={}){this.journal=journal;this.getSession=getSession;this.entries=new Map();this.active=new Set();this.timeoutMs=timeoutMs;}
  register(owner,page,handlers){
    if(!name(owner)||!method(page)||!handlers||typeof handlers!=='object'||Array.isArray(handlers)||!Object.keys(handlers).length||Object.keys(handlers).length>24)fail('EXTENSION_RPC_REGISTRATION_INVALID');
    const key=owner+':'+page;if(this.entries.has(key))fail('EXTENSION_RPC_DUPLICATE');
    const methods=new Map();for(const [id,item] of Object.entries(handlers)){if(!method(id)||!item||!['read','write'].includes(item.mode)||typeof item.handle!=='function')fail('EXTENSION_RPC_REGISTRATION_INVALID');methods.set(id,{mode:item.mode,handle:item.handle});}
    const entry={key,methods,generation:randomUUID(),controller:new AbortController()};this.entries.set(key,entry);
    return ()=>{if(this.entries.get(key)===entry)this.entries.delete(key);entry.controller.abort(Error('EXTENSION_RPC_DISPOSED'));};
  }
  catalog(){return [...this.entries.values()].map(entry=>({key:entry.key,generation:entry.generation,methods:[...entry.methods].map(([name,m])=>({name,mode:m.mode}))}));}
  async call(input){
    const session=this.getSession();if(input.sessionId!==session)fail('STALE_SESSION');
    const entry=this.entries.get(input.key),handler=entry?.methods.get(input.method);
    if(!handler||entry.generation!==input.generation)fail('EXTENSION_RPC_UNAVAILABLE');
    if(handler.mode!==input.mode)fail('EXTENSION_RPC_MODE_MISMATCH');
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))fail('EXTENSION_RPC_REQUEST_INVALID');
    const payload=pageJson(input.payload??null),digest=createHash('sha256').update(JSON.stringify([input.key,input.method,input.mode,payload])).digest('hex'),ledger='extension-page-write:'+input.requestId;
    const before=handler.mode==='write'?this.journal.value(session,ledger,null):null;
    if(before){if(before.digest!==digest)fail('EXTENSION_RPC_REQUEST_CONFLICT');if(before.status==='completed')return {value:before.value,replayed:true};fail('EXTENSION_RPC_RESULT_UNKNOWN');}
    if(this.active.size>=8)fail('EXTENSION_RPC_BUSY');
    const token={},timeout=AbortSignal.timeout(this.timeoutMs),signal=AbortSignal.any([timeout,entry.controller.signal]);let stop;
    if(handler.mode==='write')this.journal.put(session,ledger,{digest,status:'started',created:Date.now()});
    this.journal.audit(session,'extension-page-call',{key:input.key,method:input.method,mode:input.mode,requestId:input.requestId,phase:'started'});
    this.active.add(token);
    const execution=Promise.resolve().then(()=>{signal.throwIfAborted();return handler.handle(payload,Object.freeze({sessionId:session,requestId:input.requestId,signal}));});
    // Timed-out work retains its concurrency slot until it actually settles.
    execution.finally(()=>this.active.delete(token)).catch(()=>{});
    try{
      const aborted=new Promise((_,reject)=>{stop=()=>reject(Error(timeout.aborted?'EXTENSION_RPC_TIMEOUT':'EXTENSION_RPC_DISPOSED'));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
      const value=pageJson(await Promise.race([execution,aborted]));signal.throwIfAborted();
      if(this.entries.get(input.key)!==entry||this.getSession()!==session)fail('EXTENSION_RPC_DISPOSED');
      if(handler.mode==='write')this.journal.put(session,ledger,{digest,status:'completed',value,created:Date.now()});
      this.journal.audit(session,'extension-page-call',{key:input.key,method:input.method,mode:input.mode,requestId:input.requestId,phase:'completed'});
      return {value,replayed:false};
    }catch(error){
      const code=timeout.aborted?'EXTENSION_RPC_TIMEOUT':entry.controller.signal.aborted?'EXTENSION_RPC_DISPOSED':/^EXTENSION_[A-Z_]+$/.test(error?.message??'')?error.message:'EXTENSION_RPC_FAILED';
      if(handler.mode==='write')this.journal.put(session,ledger,{digest,status:'unknown',code,created:Date.now()});
      this.journal.audit(session,'extension-page-call',{key:input.key,method:input.method,mode:input.mode,requestId:input.requestId,phase:'failed',code});throw Error(code);
    }finally{if(stop)signal.removeEventListener('abort',stop);}
  }
  close(){for(const entry of this.entries.values())entry.controller.abort();this.entries.clear();}
}
