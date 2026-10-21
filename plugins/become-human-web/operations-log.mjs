import fs from 'node:fs';
import path from 'node:path';

export const operationsLogPolicy=Object.freeze({maxBytes:1048576,archives:3});
export function assertOfflineStoreUnlocked(root){try{fs.lstatSync(path.join(root,'.human-offline.lock'));throw new Error('OFFLINE_STORE_LOCKED');}catch(error){if(error.code!=='ENOENT')throw error;}}
const runningRecord=file=>{
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)throw new Error('RUNNING_STORE_LOCKED');
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('RUNNING_STORE_LOCKED');}if(!value||typeof value!=='object'||!Number.isSafeInteger(value.pid)||value.pid<1||typeof value.nonce!=='string'||!/^[a-f0-9-]{36}$/i.test(value.nonce))throw new Error('RUNNING_STORE_LOCKED');return value;
};
const pidAbsent=pid=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}};
export function releaseRunningLock(lease){
  if(!lease)return;
  let current;try{current=runningRecord(lease.file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(current.pid!==lease.pid||current.nonce!==lease.nonce)throw new Error('RUNNING_STORE_LOCK_CHANGED');
  fs.unlinkSync(lease.file);
}
export function assertRunningLock(lease){if(!lease)throw new Error('RUNNING_STORE_NOT_OWNED');const current=runningRecord(lease.file);if(current.pid!==lease.pid||current.nonce!==lease.nonce)throw new Error('RUNNING_STORE_LOCK_CHANGED');}
export function adoptRunningLock(root,nonce){
  root=path.resolve(root);assertOfflineStoreUnlocked(root);if(fs.realpathSync(root)!==root)throw new Error('LINKED_RUNTIME_HOME');
  if(typeof nonce!=='string'||!/^[a-f0-9-]{36}$/i.test(nonce))throw new Error('RUNNING_STORE_LOCK_CHANGED');
  const file=path.join(root,'.human-running.lock');let current;try{current=runningRecord(file);}catch(error){if(error.code==='ENOENT')throw new Error('RUNNING_STORE_LOCKED');throw error;}
  if(current.pid!==process.pid||current.nonce!==nonce)throw new Error('RUNNING_STORE_LOCK_CHANGED');assertOfflineStoreUnlocked(root);return {file,pid:current.pid,nonce:current.nonce,at:current.at};
}
export function acquireRunningLock(root){
  root=path.resolve(root);assertOfflineStoreUnlocked(root);fs.mkdirSync(root,{recursive:true});if(fs.realpathSync(root)!==root)throw new Error('LINKED_RUNTIME_HOME');
  const file=path.join(root,'.human-running.lock');
  try{const previous=runningRecord(file);if(!pidAbsent(previous.pid))throw new Error('RUNNING_STORE_LOCKED');const current=runningRecord(file);if(current.pid!==previous.pid||current.nonce!==previous.nonce||!pidAbsent(current.pid))throw new Error('RUNNING_STORE_LOCKED');fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  const lease={file,pid:process.pid,nonce:crypto.randomUUID(),at:Date.now()};let fd;
  try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:lease.pid,nonce:lease.nonce,at:lease.at}));fs.fsyncSync(fd);}catch(error){if(error.code==='EEXIST')throw new Error('RUNNING_STORE_LOCKED');throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
  try{assertOfflineStoreUnlocked(root);}catch(error){releaseRunningLock(lease);throw error;}return lease;
}
export const safeOperationCode=(error,fallback='OPERATION_FAILED')=>{
  for(const code of [error?.code,error?.message])if(typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(code))return code.toUpperCase().replaceAll('-','_');
  return fallback;
};
const redact=text=>String(text).replace(/([?&](?:token|api_key|access_token)=)[^\s&"'<>]+/gi,'$1[REDACTED]').replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [REDACTED]').replace(/\bsk-[\w-]{16,}/g,'[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"'<>]+/gi,'$1[REDACTED]');
const clean=(value,depth=0)=>{
  if(depth>5)return '[omitted]';
  if(typeof value==='string')return redact(value).slice(0,16384);
  if(Array.isArray(value))return value.slice(0,30).map(v=>clean(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['token','password','secret','apiKey','headers','cookie','credentials','body','messages'].includes(key)).map(([key,v])=>[key,clean(v,depth+1)]));
  return value;
};

// Keep lifecycle facts separate from worker output. Neither file is a source of
// runtime authority; losing diagnostics must remain visible without changing it.
export class OperationsLog {
  constructor(root,metadata){this.root=path.resolve(root);this.metadata=metadata;this.lastError=null;this.lastReportedError=null;this.lease=null;}
  append(file,kind,data={}){
    try{
      assertOfflineStoreUnlocked(this.root);
      assertRunningLock(this.lease);
      fs.mkdirSync(this.root,{recursive:true});
      if(fs.realpathSync(this.root)!==this.root)throw new Error('LINKED_RUNTIME_HOME');
      const target=path.join(this.root,file),line=JSON.stringify({...this.metadata(),...clean(data),at:new Date().toISOString(),kind})+'\n';
      let size=0;try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('LINKED_OPERATIONS_LOG');size=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(size+Buffer.byteLength(line)>operationsLogPolicy.maxBytes){
        fs.rmSync(target+'.'+operationsLogPolicy.archives,{force:true});
        for(let index=operationsLogPolicy.archives-1;index>=1;index--){try{fs.renameSync(target+'.'+index,target+'.'+(index+1));}catch(error){if(error.code!=='ENOENT')throw error;}}
        try{fs.renameSync(target,target+'.1');}catch(error){if(error.code!=='ENOENT')throw error;}
      }
      fs.appendFileSync(target,line,{mode:0o600,flush:true});
      this.lastError=null;this.lastReportedError=null;return true;
    }catch(error){
      this.lastError={at:Date.now(),code:safeOperationCode(error,'OPERATIONS_LOG_WRITE_FAILED')};
      if(this.lastReportedError!==this.lastError.code){this.lastReportedError=this.lastError.code;console.error(JSON.stringify({at:new Date().toISOString(),kind:'operations-log-error',code:this.lastError.code,pid:process.pid}));}
      return false;
    }
  }
  lifecycle(kind,data){return this.append('manager-lifecycle.jsonl',kind,data);}
  output(stream,text,workerPid){return this.append('manager-worker.log','worker-output',{stream,text,workerPid,truncated:String(text).length>16384});}
}
