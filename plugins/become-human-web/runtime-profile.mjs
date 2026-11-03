import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-become-human-runtime'];
const plain=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const packageName=x=>typeof x==='string'&&/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(x);
export function behaviorReplacementIds(manifest){
  const ids=manifest.dsh?.human?.replacesBehaviors??[];
  if(!Array.isArray(ids)||ids.length>1||ids.some(id=>id!=='reflect-experience'))throw Error('INVALID_RUNTIME_BEHAVIOR_OVERRIDE');
  return [...ids];
}
export function workflowIds(manifest){
  const ids=manifest.dsh?.human?.providesWorkflows??[];
  if(!Array.isArray(ids)||ids.length>1||ids.some(id=>id!=='deep-learning'))throw Error('INVALID_RUNTIME_WORKFLOW');
  return [...ids];
}
export async function externalBehaviorOwners(profile,manifest){
  const owners={};
  for(const name of manifest.dsh.profile.bundles.filter(name=>!bundles.includes(name))){
    const text=await regularText(path.join(profile,'node_modules',name,'package.json'));
    if(text===null)throw Error('RUNTIME_EXTENSION_PACKAGE_MISSING');
    const pkg=JSON.parse(text);
    for(const id of [...behaviorReplacementIds(pkg),...workflowIds(pkg)]){if(owners[id])throw Error('RUNTIME_BEHAVIOR_OVERRIDE_CONFLICT');owners[id]=name;}
  }
  return owners;
}
export function runtimeProfileManifest(existing={}){
  if(!plain(existing)||existing.dsh!==undefined&&!plain(existing.dsh)||existing.dsh?.profile!==undefined&&!plain(existing.dsh.profile))throw Error('INVALID_RUNTIME_PROFILE_MANIFEST');
  const installed=existing.dsh?.profile?.bundles??[];
  if(!Array.isArray(installed)||installed.length>64||installed.some(name=>!packageName(name)))throw Error('INVALID_RUNTIME_PLUGIN_BUNDLES');
  // Retain package-manager dependency records. The Human bundle stays last so
  // its single-agent runtime choices are applied after extension bundles.
  return {...existing,name:'become-human-private-runtime',private:true,type:'module',dsh:{...existing.dsh,profile:{...existing.dsh?.profile,bundles:[...bundles.slice(0,2),...new Set(installed.filter(name=>!bundles.includes(name))),bundles[2]]}}};
}
export function runtimeExtensionPatch(value){
  if(value==null)return [];
  if(!Array.isArray(value)||value.length>64)throw Error('INVALID_RUNTIME_EXTENSION_PATCH');
  const ids=new Set();
  for(const entry of value){
    if(!plain(entry)||typeof entry.id!=='string'||!/^human-extension\.[a-z0-9][a-z0-9._-]{0,120}$/.test(entry.id)||ids.has(entry.id)||Object.keys(entry).some(key=>!['id','config','disabled'].includes(key))||entry.disabled!==undefined&&typeof entry.disabled!=='boolean'||entry.config!==undefined&&!plain(entry.config))throw Error('INVALID_RUNTIME_EXTENSION_PATCH');
    ids.add(entry.id);
  }
  if(Buffer.byteLength(JSON.stringify(value))>65536)throw Error('RUNTIME_EXTENSION_PATCH_TOO_LARGE');
  return value;
}
async function regularText(file){
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>524288)throw Error('INVALID_RUNTIME_PROFILE_FILE');return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function prepareRuntimeProfile(profile,managedPatch){
  const manifestFile=path.join(profile,'package.json'),existing=await regularText(manifestFile),manifest=runtimeProfileManifest(existing?JSON.parse(existing):{});
  const extensionText=await regularText(path.join(profile,'human-extensions.patch.yml'));
  const extensions=runtimeExtensionPatch(extensionText?YAML.parse(extensionText,{customTags:[],uniqueKeys:true}):[]);
  // Explicit extension configuration is separate from the generated file.
  // Package installation/removal is delegated to the standard DSH CLI.
  // Installed ownership survives node disable. Removal explicitly restores the
  // bundled implementation; disable must never silently reactivate it.
  const owners=await externalBehaviorOwners(profile,manifest);
  const patch=[...extensions,...managedPatch.map(node=>node.id==='become-human'?{...node,config:{...node.config,externalBehaviorIds:Object.keys(owners).filter(id=>id==='reflect-experience')}}:node)];
  for(const [file,text] of [[manifestFile,JSON.stringify(manifest,null,2)+'\n'],[path.join(profile,'cordis.patch.yml'),YAML.stringify(patch)]]){
    await regularText(file);const tmp=file+'.'+crypto.randomUUID()+'.tmp';
    try{await fs.writeFile(tmp,text,{flag:'wx'});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  return {bundles:manifest.dsh.profile.bundles,behaviorOwners:owners};
}
