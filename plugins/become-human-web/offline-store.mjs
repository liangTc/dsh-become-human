import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {protectKey} from './runtime/dpapi.mjs';

const MAX_BYTES=128*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new Error(code);};
async function isOpen(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.setTimeout(1200);socket.once('connect',()=>finish(true));socket.once('error',e=>e.code==='ECONNREFUSED'?finish(false):finish(true));socket.once('timeout',()=>finish(true));});}
function rootsOf(options){const roots={runtime:path.resolve(options.runtimeHome??''),manager:path.resolve(options.managerHome??'')},outside=rel=>rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel);if(!options.runtimeHome||!options.managerHome||roots.runtime===roots.manager||Object.values(roots).some(x=>x===path.parse(x).root)||Object.values(roots).some(x=>x.startsWith('\\\\')))fail('INVALID_BACKUP_ROOTS');if(!outside(path.relative(roots.runtime,roots.manager))||!outside(path.relative(roots.manager,roots.runtime)))fail('NESTED_BACKUP_ROOTS');return roots;}
async function lockHomes(roots,ports){
  if(!Array.isArray(ports)||ports.length<1||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535))fail('INVALID_BACKUP_PORTS');
  if((await Promise.all(ports.map(isOpen))).some(Boolean))fail('STOP_SERVICES_BEFORE_BACKUP');
  const locks=[];try{for(const root of Object.values(roots)){await fs.mkdir(root,{recursive:true});if(await fs.realpath(root)!==root)fail('LINKED_BACKUP_ROOT');const file=path.join(root,'.human-offline.lock'),handle=await fs.open(file,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await handle.close();locks.push(file);}for(const root of Object.values(roots)){try{await fs.lstat(path.join(root,'.human-running.lock'));fail('RUNNING_OR_STALE_SERVICE_LOCK');}catch(e){if(e.code!=='ENOENT')throw e;}}if((await Promise.all(ports.map(isOpen))).some(Boolean))fail('SERVICE_STARTED_DURING_BACKUP');return async()=>{for(const file of locks)await fs.unlink(file);};}catch(e){for(const file of locks)await fs.unlink(file).catch(()=>{});throw e;}
}
function fileTarget(root,relative){if(typeof relative!=='string'||!relative||relative.includes(':')||relative.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))fail('INVALID_BACKUP_ENTRY');const target=path.resolve(root,...relative.split('/')),rel=path.relative(root,target);if(!rel||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('INVALID_BACKUP_ENTRY');return target;}
async function capture(root,scope,files,counter,dir=root){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.name==='node_modules'||entry.name==='.human-offline.lock')continue;const full=path.join(dir,entry.name),stat=await fs.lstat(full);if(stat.isSymbolicLink())fail('LINKED_BACKUP_ENTRY');if(stat.isDirectory()){await capture(root,scope,files,counter,full);continue;}if(!stat.isFile())fail('UNSUPPORTED_BACKUP_ENTRY');if(stat.size>MAX_BYTES||counter.bytes+stat.size>MAX_BYTES)fail('BACKUP_CAPACITY_EXCEEDED');const body=await fs.readFile(full),after=await fs.stat(full);if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||body.length!==stat.size)fail('BACKUP_SOURCE_CHANGED');counter.bytes+=body.length;files.push({scope,path:path.relative(root,full).split(path.sep).join('/'),bytes:body.length,sha256:sha(body),body:body.toString('base64')});}}

export async function backupStore(options){
  const roots=rootsOf(options),destination=path.resolve(options.destination??'');if(!options.destination||Object.values(roots).some(r=>{const rel=path.relative(r,destination);return !rel||!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}))fail('BACKUP_DESTINATION_OUTSIDE_HOMES_REQUIRED');
  const unlock=await lockHomes(roots,options.ports??[3090,3081]);let key;
  try{
    const files=[],counter={bytes:0};for(const [scope,root] of Object.entries(roots))await capture(root,scope,files,counter);
    const header={format:'human-offline-backup-v1',createdAt:new Date().toISOString(),roots,files:files.length,bytes:counter.bytes,restoreScope:'Same Windows account and same absolute homes. Reinstall plugins separately. Not a portable cross-machine key migration.'};
    key=randomBytes(32);const iv=randomBytes(12),wrappedKey=protectKey('protect',key.toString('hex')),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));const plaintext=gzipSync(Buffer.from(JSON.stringify(files))),encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);plaintext.fill(0);
    const archive=Buffer.from(JSON.stringify({header,wrappedKey,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')}));const out=await fs.open(destination,'wx',0o600);try{await out.writeFile(archive);await out.sync();}finally{await out.close();}
    return {...header,destination,archiveSha256:sha(archive),encrypted:true};
  }finally{key?.fill(0);await unlock();}
}

export async function inspectBackup(options){
  const stat=await fs.stat(options.archive);if(stat.size>MAX_BYTES*4)fail('INVALID_BACKUP_SIZE');const archive=await fs.readFile(options.archive),value=JSON.parse(archive.toString('utf8'));
  if(value.header?.format!=='human-offline-backup-v1')fail('INVALID_BACKUP_FORMAT');
  let key,plain;
  try{key=Buffer.from(protectKey('unprotect',value.wrappedKey),'hex');const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify(value.header)));decipher.setAuthTag(Buffer.from(value.tag,'base64'));plain=gunzipSync(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]),{maxOutputLength:MAX_BYTES*2});const files=JSON.parse(plain.toString('utf8'));let bytes=0;const names=new Set();for(const f of files){if(!['runtime','manager'].includes(f.scope)||!Number.isSafeInteger(f.bytes)||f.bytes<0)fail('INVALID_BACKUP_ENTRY');fileTarget(value.header.roots[f.scope],f.path);const name=f.scope+'/'+f.path.toLowerCase();if(names.has(name))fail('DUPLICATE_BACKUP_ENTRY');names.add(name);const body=Buffer.from(f.body,'base64');if(body.length!==f.bytes||sha(body)!==f.sha256)fail('BACKUP_HASH_MISMATCH');bytes+=body.length;if(bytes>MAX_BYTES)fail('INVALID_BACKUP_SIZE');}if(files.length!==value.header.files||bytes!==value.header.bytes)fail('BACKUP_MANIFEST_MISMATCH');return {header:value.header,files,archiveSha256:sha(archive)};}finally{key?.fill(0);plain?.fill(0);}
}

export async function restoreStore(options){
  const roots=rootsOf(options),verified=await inspectBackup(options);if(JSON.stringify(roots)!==JSON.stringify(verified.header.roots))fail('RESTORE_SAME_PATHS_REQUIRED');
  const unlock=await lockHomes(roots,options.ports??[3090,3081]);let restoring=false,complete=false;
  try{
    for(const root of Object.values(roots))if((await fs.readdir(root)).some(x=>x!=='.human-offline.lock'))fail('RESTORE_EMPTY_HOMES_REQUIRED');
    restoring=true;for(const file of verified.files){const target=fileTarget(roots[file.scope],file.path);await fs.mkdir(path.dirname(target),{recursive:true});if(await fs.realpath(path.dirname(target))!==path.dirname(target))fail('LINKED_RESTORE_PATH');const handle=await fs.open(target,'wx',0o600);try{await handle.writeFile(Buffer.from(file.body,'base64'));await handle.sync();}finally{await handle.close();}if(sha(await fs.readFile(target))!==file.sha256)fail('RESTORE_VERIFY_FAILED');}
    complete=true;
    return {restored:true,files:verified.files.length,roots,archiveSha256:verified.archiveSha256,requiresPluginReinstall:true,requiresExplicitStart:true};
  }finally{if(!restoring||complete)await unlock();else for(const root of Object.values(roots))await fs.writeFile(path.join(root,'.human-restore-incomplete.json'),JSON.stringify({at:new Date().toISOString(),code:'RESTORE_INCOMPLETE',action:'Offline locks retained. Keep services stopped and inspect or restore into verified empty homes.'})).catch(()=>{});}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [mode,...args]=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){const key={'--runtime-home':'runtimeHome','--manager-home':'managerHome','--destination':'destination','--archive':'archive','--ports':'ports'}[args[i]];if(!key||!args[i+1])fail('INVALID_BACKUP_ARGUMENTS');options[key]=key==='ports'?args[i+1].split(',').map(Number):args[i+1];}
  try{const result=mode==='backup'?await backupStore(options):mode==='restore'?await restoreStore(options):mode==='verify'?await inspectBackup(options).then(x=>({...x.header,archiveSha256:x.archiveSha256,verified:true})):fail('USE_BACKUP_VERIFY_OR_RESTORE');console.log(JSON.stringify(result));}catch(e){console.error(JSON.stringify({ok:false,code:/^[A-Z_]{3,80}$/.test(e.message)?e.message:'OFFLINE_STORE_FAILED'}));process.exitCode=1;}
}
