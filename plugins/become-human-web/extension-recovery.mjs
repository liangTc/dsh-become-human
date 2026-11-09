import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const names=['package.json','pnpm-lock.yaml','human-extensions.patch.yml','cordis.patch.yml','pnpm-workspace.yaml'];
const digest=value=>createHash('sha256').update(value).digest('hex'),fail=code=>{throw Error(code);};
export async function recoveryFile(file){try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)fail('EXTENSION_RECOVERY_FILE_INVALID');return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function replace(file,text){await recoveryFile(file);if(text===null){await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});return;}const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,text,{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
export async function profileImage(profile){const files={};for(const name of names)files[name]=await recoveryFile(path.join(profile,name));return {files,digest:digest(JSON.stringify(files))};}
export class ExtensionRecovery {
 constructor(root,profile){this.root=root;this.profile=profile;}
 file(id){if(!/^[a-f0-9-]{36}$/.test(id))fail('EXTENSION_RECOVERY_INVALID');return path.join(this.root,'recovery-'+id+'.json');}
 async capture(id,{packages=false,sessionId=null}={}){
  const image=await profileImage(this.profile),manifest=JSON.parse(image.files['package.json']),installed={};
  if(packages&&!image.files['pnpm-lock.yaml']&&Object.keys(manifest.dependencies??{}).length)fail('EXTENSION_RECOVERY_LOCK_REQUIRED');
  if(packages)for(const name of Object.keys(manifest.dependencies??{})){
   if(!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))fail('EXTENSION_RECOVERY_INVALID');
   const body=await recoveryFile(path.join(this.profile,'node_modules',name,'package.json'));if(!body)fail('EXTENSION_RECOVERY_BASELINE_INVALID');installed[name]=JSON.parse(body).version;
  }
  const snapshot={version:1,id,profile:path.resolve(this.profile),packages,sessionId,installed,...image},body=JSON.stringify(snapshot);
  if(Buffer.byteLength(body)>8*1024*1024)fail('EXTENSION_RECOVERY_TOO_LARGE');
  await fs.writeFile(this.file(id),body,{flag:'wx',mode:0o600});return {status:'prepared',snapshotDigest:digest(body),before:image.digest,after:image.digest,packages};
 }
 async load(job){const body=await recoveryFile(this.file(job.id));if(!body||digest(body)!==job.recovery.snapshotDigest)fail('EXTENSION_RECOVERY_CHANGED');const s=JSON.parse(body);if(s.id!==job.id||s.profile!==path.resolve(this.profile)||s.version!==1||Object.keys(s.files).sort().join()!==[...names].sort().join()||Object.values(s.files).some(x=>x!==null&&typeof x!=='string')||digest(JSON.stringify(s.files))!==s.digest)fail('EXTENSION_RECOVERY_INVALID');return s;}
 async restoreFiles(snapshot){for(const name of names)await replace(path.join(this.profile,name),snapshot.files[name]);}
 async isolateEmptyBaselineModules(snapshot){
  const manifest=JSON.parse(snapshot.files['package.json']);
  if(['dependencies','devDependencies','optionalDependencies','peerDependencies'].some(key=>Object.keys(manifest[key]??{}).length))return null;
  // pnpm checks node_modules/.pnpm/lock.yaml even when package.json has been
  // restored to an empty baseline. Preserve the failed install for inspection,
  // but do not let its lockfile participate in the offline restore.
  const source=path.join(this.profile,'node_modules');
  const stat=await fs.lstat(source).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return null;
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('EXTENSION_RECOVERY_FILE_INVALID');
  const target=path.join(this.profile,'.human-recovery-modules-'+snapshot.id+'-'+randomUUID());
  await fs.rename(source,target);return path.basename(target);
 }
 async verifyPackages(snapshot){for(const [name,version] of Object.entries(snapshot.installed)){const body=await recoveryFile(path.join(this.profile,'node_modules',name,'package.json'));if(!body||JSON.parse(body).version!==version)fail('EXTENSION_RECOVERY_PACKAGE_MISMATCH');}}
 async discard(id){await fs.unlink(this.file(id)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
