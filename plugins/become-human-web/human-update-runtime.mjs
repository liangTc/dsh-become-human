import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import semver from 'semver';
import YAML from 'yaml';
import {profileImage,recoveryFile} from './extension-recovery.mjs';
import {runExtensionCli} from './extensions.mjs';

export const HUMAN_PACKAGE='dsh-become-human-web',HUMAN_REGISTRY='https://registry.npmjs.org/';
const fail=code=>{throw Error(code);};
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
export const digest=value=>createHash('sha256').update(value).digest('hex');

async function boundedResponse(url,{fetchImpl=fetch,limit,timeout=15000,signal}={}){
 try{
  const response=await fetchImpl(url,{headers:{accept:'application/json'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  if(response.status===404)fail('UPDATE_RELEASE_NOT_FOUND');
  if(!response.ok)fail('UPDATE_DOWNLOAD_FAILED');
  if(Number(response.headers.get('content-length'))>limit)fail('UPDATE_FILE_TOO_LARGE');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)fail('UPDATE_FILE_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
 }catch(e){if(/^UPDATE_[A-Z_]+$/.test(e.message))throw e;fail('UPDATE_DOWNLOAD_FAILED');}
}
export async function fetchHumanRelease(channel,{fetchImpl=fetch,dshVersion,nodeVersion=process.versions.node}={}){
 if(!['beta','latest'].includes(channel))fail('UPDATE_CHANNEL_INVALID');
 let release;try{release=JSON.parse(await boundedResponse(HUMAN_REGISTRY+HUMAN_PACKAGE+'/'+channel,{fetchImpl,limit:524288}));}catch(e){if(e instanceof SyntaxError)fail('UPDATE_RELEASE_INVALID');throw e;}
 const version=release.version;
 if(release.name!==HUMAN_PACKAGE||semver.valid(version)!==version)fail('UPDATE_RELEASE_INVALID');
 if(channel==='latest'&&semver.prerelease(version))fail('UPDATE_STABLE_UNAVAILABLE');
 const url=new URL(release.dist?.tarball??'invalid',HUMAN_REGISTRY),integrity=release.dist?.integrity;
 if(url.href!==HUMAN_REGISTRY+HUMAN_PACKAGE+'/-/'+HUMAN_PACKAGE+'-'+version+'.tgz'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity??''))fail('UPDATE_RELEASE_INVALID');
 const nodeRange=release.engines?.node,dshRange=release.dsh?.compatibility?.dsh??release.peerDependencies?.['@deepseek-ai/dsh'];
 if(!semver.validRange(nodeRange)||!semver.validRange(dshRange))fail('UPDATE_RELEASE_INVALID');
 return {version,channel,tarball:url.href,integrity,nodeRange,dshRange,blockedReason:!semver.satisfies(nodeVersion,nodeRange)?'UPDATE_NODE_INCOMPATIBLE':!semver.satisfies(dshVersion,dshRange,{includePrerelease:true})?'UPDATE_DSH_INCOMPATIBLE':null};
}
export async function downloadHumanRelease(release,file,{fetchImpl=fetch,signal}={}){
 const bytes=await boundedResponse(release.tarball,{fetchImpl,signal,limit:48*1024*1024,timeout:120000});
 if('sha512-'+createHash('sha512').update(bytes).digest('base64')!==release.integrity)fail('UPDATE_INTEGRITY_FAILED');
 let tar;try{tar=gunzipSync(bytes,{maxOutputLength:160*1024*1024});}catch{fail('UPDATE_ARCHIVE_INVALID');}
 let manifest;const files=new Set();
 for(let offset=0;offset+512<=tar.length;){
  const h=tar.subarray(offset,offset+512);if(h.every(x=>x===0))break;
  const text=(a,b)=>h.subarray(a,b).toString().replace(/\0.*$/s,'').trim(),name=[text(345,500),text(0,100)].filter(Boolean).join('/'),type=text(156,157),n=text(124,136),sum=text(148,156);
  if(!/^[0-7]+$/.test(n)||!/^[0-7]+$/.test(sum)||h.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0)!==parseInt(sum,8))fail('UPDATE_ARCHIVE_INVALID');
  const size=parseInt(n,8);
  if(!name.startsWith('package/')||name.includes('\\')||name.split('/').some(s=>s==='..'||s==='.')||!['','0','5'].includes(type)||files.has(name)||offset+512+size>tar.length)fail('UPDATE_ARCHIVE_INVALID');
  files.add(name);
  if(name==='package/package.json'){try{manifest=JSON.parse(tar.subarray(offset+512,offset+512+size));}catch{fail('UPDATE_ARCHIVE_INVALID');}}
  offset+=512+Math.ceil(size/512)*512;
 }
 if(manifest?.name!==HUMAN_PACKAGE||manifest.version!==release.version||!files.has('package/manager.mjs')||!files.has('package/runtime/index.mjs')||!files.has('package/client.js')||!files.has('package/cordis.patch.yml'))fail('UPDATE_ARCHIVE_INVALID');
 if(manifest.engines?.node!==release.nodeRange||(manifest.dsh?.compatibility?.dsh??manifest.peerDependencies?.['@deepseek-ai/dsh'])!==release.dshRange)fail('UPDATE_ARCHIVE_INVALID');
 await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return {sha256:digest(bytes)};
}

// All executable paths and profile facts originate in the host, never RPC input.
export class HumanUpdateRuntime {
 constructor({profileContext,home,loadedDir=import.meta.dirname,run=runExtensionCli}){this.context=profileContext;this.home=home;this.loadedDir=loadedDir;this.run=run;}
 async inspect(){
  try{
   const p=this.context;if(!p||!path.isAbsolute(p.dir??'')||!path.isAbsolute(this.home??'')||!/^[a-zA-Z0-9_-]{1,64}$/.test(p.name??''))fail('UPDATE_PROFILE_UNAVAILABLE');
   this.profile=await fs.realpath(p.dir);
   const declared=await fs.realpath(path.join(this.home,'profiles',p.name)).catch(()=>fail('UPDATE_PROFILE_UNAVAILABLE'));
   if(this.profile!==declared)fail('UPDATE_PROFILE_UNAVAILABLE');
   const installed=await fs.realpath(path.join(this.profile,'node_modules',HUMAN_PACKAGE)),loaded=await fs.realpath(this.loadedDir);
   const pkg=JSON.parse(await recoveryFile(path.join(installed,'package.json'))),image=await profileImage(this.profile);
   if(pkg.name!==HUMAN_PACKAGE||!semver.valid(pkg.version))fail('UPDATE_INSTALLATION_INVALID');
   let blockedReason=null;
   if(!inside(path.join(this.profile,'node_modules'),installed))blockedReason='UPDATE_SOURCE_INSTALL';
   else if(!this.bound&&installed!==loaded)blockedReason='UPDATE_INSTALLATION_CHANGED';
   if(installed===loaded)this.bound=true;
   for(const file of ['manager.mjs','client.js','runtime/index.mjs','cordis.patch.yml']){const target=path.join(installed,file);if(!inside(installed,await fs.realpath(target))||!(await fs.stat(target)).isFile())fail('UPDATE_INSTALLATION_INVALID');}
   const identity=digest(this.profile+'\0'+installed+'\0'+pkg.version+'\0'+image.digest);
   return {installedVersion:pkg.version,profileName:p.name,identity,blockedReason};
  }catch(e){return {installedVersion:null,blockedReason:/^UPDATE_[A-Z_]+$/.test(e.message)?e.message:'UPDATE_INSTALLATION_INVALID'};}
 }
 async cli(args,signal){
  const require=createRequire(import.meta.url),file=require.resolve('@deepseek-ai/dsh/package.json'),pkg=JSON.parse(await fs.readFile(file)),entry=path.resolve(path.dirname(file),pkg.bin.dsh);
  const modules=await recoveryFile(path.join(this.profile,'node_modules','.modules.yaml')),store=modules?YAML.parse(modules)?.storeDir:null;
  const storeArgs=typeof store==='string'&&path.isAbsolute(store)?['--store-dir='+(/^v\d+$/.test(path.basename(store))?path.dirname(store):store)]:[];
  return this.run({entry,home:this.home,profile:this.context.name,args:[...args,...storeArgs],signal});
 }
 async install(file,signal){return this.cli(['add',file,'--save-exact','--ignore-scripts','--registry='+HUMAN_REGISTRY],signal);}
 async restore(signal){return this.cli(['install','--frozen-lockfile','--offline','--ignore-scripts'],signal);}
}
