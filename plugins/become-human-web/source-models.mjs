import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readSourceCredentialReferences} from './source-credentials.mjs';

// These APIs are part of the DSH ABI declared by this package. Reading the
// composition never boots a profile or imports any source-profile plugin.
const DSH_ABI='0.2.0-rc.2';
const nativeProvider='deepseek-official';
const providerFields=['apiKeyEnv','displayName','api','baseURL','models','modelOverrides','compat','defaultContextWindow','defaultMaxTokens','reasoning','thinkingBudgets','timeoutMs','streamIdleTimeoutMs'];
const nativeFields=['apiKeyEnv','baseURL','thinking','reasoningEffort','maxTokens','defaultContextWindow','models','streamIdleTimeoutMs','maxRequestFilesBytes','maxInlineRequestImageBytes','maxImagesPerRequest','imageOffloadByteQuantum','inlineImageOffloadByteQuantum','imageOffloadCountQuantum','filesApiTimeoutMs','fileExpiresAfterSeconds','fileRefreshMarginSeconds','fileQuotaCleanupBatch','retryPolicy'];
const credentialName=value=>typeof value==='string'&&/^\w+$/.test(value);
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const modalities=model=>{const value=model.inputModalities??model.input;return Array.isArray(value)?{inputModalities:[...new Set(value.filter(value=>value==='text'||value==='image'))]}:{};};

async function officialModules(){
  try{
    const local=createRequire(import.meta.url),installAnchor=local.resolve('@deepseek-ai/dsh/package.json'),installation=createRequire(installAnchor);
    const baseAnchor=installation.resolve('@deepseek-ai/dsh-base/package.json'),base=createRequire(baseAnchor);
    const load=async name=>{
      let manifestFile;try{manifestFile=installation.resolve(name+'/package.json');}catch{manifestFile=base.resolve(name+'/package.json');}
      const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
      if(manifest.version!==DSH_ABI)throw new Error('SOURCE_NATIVE_ADAPTER_UNSUPPORTED');
      return import(pathToFileURL(createRequire(manifestFile).resolve(name)).href);
    };
    return {installAnchor,boot:await load('@deepseek-ai/dsh-app-boot'),native:()=>load('@deepseek-ai/dsh-llm-deepseek-api-key')};
  }catch{throw new Error('SOURCE_NATIVE_ADAPTER_UNSUPPORTED');}
}

async function exists(file){try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function composition(config,modules){
  const dir=path.join(config.sourceHome,'profiles',config.sourceProfile),manifestFile=path.join(dir,'package.json'),boot=modules.boot;
  let profile;
  try{
    if(await exists(manifestFile)){
      profile=boot.loadProfileDirectory('become-human',dir,modules.installAnchor);
    }else{
      // A shipped profile's first launch initializes exactly these bundles.
      // Discover the same defaults without creating files in the source home.
      const template=boot.PROFILE_TEMPLATES[config.sourceProfile];
      if(!template)throw new Error('SOURCE_PROFILE_NOT_FOUND');
      const layers=[],skippedBundles=[];
      for(const packageName of template.bundles){
        try{
          const packageDir=boot.resolveBundleDir('become-human',packageName,modules.installAnchor,dir);
          const manifest=JSON.parse(await fs.readFile(path.join(packageDir,'package.json'),'utf8'));
          const patches=boot.bundlePatchPaths(packageDir,manifest.dsh?.bundle).flatMap(file=>boot.loadOverlayPatches('become-human',file));
          layers.push({packageName,patches});
        }catch{skippedBundles.push({packageName});}
      }
      profile={layers,patches:boot.loadOptionalPatches('become-human',path.join(dir,'cordis.patch.yml'))??[],skippedBundles};
    }
    const home=boot.loadOptionalPatches('become-human',path.join(config.sourceHome,'cordis.patch.yml'))??[];
    return {entries:boot.composeEntries([...profile.layers.map(layer=>layer.patches),profile.patches,home]),
      warnings:profile.skippedBundles.map(bundle=>({code:'SOURCE_BUNDLE_UNAVAILABLE',bundle:bundle.packageName}))};
  }catch(error){if(error.message==='SOURCE_PROFILE_NOT_FOUND')throw error;throw new Error('SOURCE_MODEL_CONFIGURATION_INVALID');}
}

function findRow(entries,id,inheritedDisabled=false){
  for(const row of entries){
    if(!record(row))continue;
    const disabled=inheritedDisabled||!!row.disabled;
    if(row.id===id)return {...row,disabled};
    if(Array.isArray(row.config)){const found=findRow(row.config,id,disabled);if(found)return found;}
  }
  return null;
}
function safeConfig(value,fields){
  const clean=Object.create(null);
  for(const key of fields)if(value[key]!==undefined)clean[key]=structuredClone(value[key]);
  return clean;
}
function containsInlineCredentials(value,seen=new Set()){
  if(!value||typeof value!=='object'||seen.has(value))return false;
  seen.add(value);
  return Object.entries(value).some(([key,item])=>key==='apiKey'||key==='headers'||containsInlineCredentials(item,seen));
}
/** Return detached model configuration and credential references, never values. */
export async function readSourceModelConfiguration(config){
  if(!path.isAbsolute(config.sourceHome??'')||typeof config.sourceProfile!=='string'||!/^[a-zA-Z0-9_-]+$/.test(config.sourceProfile))throw new Error('INVALID_RUNTIME_CONFIG');
  const modules=await officialModules(),{entries,warnings}=await composition(config,modules);
  const providers=Object.create(null),readyProviders=Object.create(null),nativeProviders=Object.create(null),readyNativeProviders=Object.create(null),models=[];
  const pi=findRow(entries,'llm-pi-ai'),rawProviders=pi&&!pi.disabled?pi.config?.providers??{}:{};
  if(!record(rawProviders))throw new Error('SOURCE_MODEL_CONFIGURATION_INVALID');
  const native=findRow(entries,'llm-deepseek'),nativeActive=native&&!native.disabled&&native.name==='@deepseek-ai/dsh-llm-deepseek-api-key';
  const requestedRefs=Object.values(rawProviders).map(provider=>provider?.apiKeyEnv).filter(credentialName);
  if(nativeActive){
    const raw=native.config??{},ref=raw.apiKeyEnv??'DEEPSEEK_API_KEY';
    if(!record(raw)||containsInlineCredentials(raw)||Object.hasOwn(raw,'protocol')||!credentialName(ref))throw new Error('SOURCE_NATIVE_MODEL_CONFIGURATION_INVALID');
    requestedRefs.push(ref);
  }
  const credentialRefs=await readSourceCredentialReferences(config,[...new Set(requestedRefs)]),credentialReady=ref=>credentialName(ref)&&!!credentialRefs.get(ref);
  for(const [provider,original] of Object.entries(rawProviders)){
    if(!provider||provider.length>256||!record(original)||containsInlineCredentials(original)||!Array.isArray(original.models)||!credentialName(original.apiKeyEnv))continue;
    const clean=safeConfig(original,providerFields),ready=credentialReady(clean.apiKeyEnv);
    providers[provider]=clean;if(ready)readyProviders[provider]=clean;
    for(const model of clean.models){
      if(!record(model)||typeof model.id!=='string'||!model.id||model.id.length>256||models.length>=512)continue;
      models.push({provider,model:model.id,providerLabel:String(clean.displayName??provider).slice(0,160),modelLabel:String(model.name??model.displayName??model.id).slice(0,200),credentialReady:ready,adapter:'pi-ai',...modalities(model)});
    }
  }
  if(nativeActive){
    if(Object.hasOwn(providers,nativeProvider))throw new Error('SOURCE_MODEL_ROUTE_CONFLICT');
    const raw=native.config??{};
    if(!record(raw)||containsInlineCredentials(raw))throw new Error('SOURCE_NATIVE_MODEL_CONFIGURATION_INVALID');
    let resolved;
    try{
      const adapter=await modules.native();
      // Endpoint resolution uses the current host's inherited environment. It
      // does not parse source .env files or mutate the host's process.env.
      const environment=config.sourceLaunchEnvironment??{get:name=>process.env[name]===undefined?undefined:{source:'process',value:process.env[name]},getFrom:(name,sources)=>sources.includes('process')&&process.env[name]!==undefined?{source:'process',value:process.env[name]}:undefined};
      // Match boot-time schema validation before advertising a ready route.
      // Resolve the original plain options, not the schema's volatile wrappers.
      adapter.Config(safeConfig(raw,nativeFields));
      resolved=adapter.resolveAdapterOptions(safeConfig(raw,nativeFields),environment);
    }catch(error){if(error.message==='SOURCE_NATIVE_ADAPTER_UNSUPPORTED')throw error;throw new Error('SOURCE_NATIVE_MODEL_CONFIGURATION_INVALID');}
    if(!credentialName(resolved.apiKeyEnv)||!Array.isArray(resolved.models))throw new Error('SOURCE_NATIVE_MODEL_CONFIGURATION_INVALID');
    const clean=safeConfig(raw,nativeFields);
    clean.apiKeyEnv=resolved.apiKeyEnv;clean.baseURL=resolved.baseURL;clean.models=structuredClone(resolved.models);
    const ready=credentialReady(clean.apiKeyEnv);nativeProviders[nativeProvider]=clean;if(ready)readyNativeProviders[nativeProvider]=clean;
    const reasoningEfforts=raw.thinking==='disabled'||resolved.defaults?.thinking==='disabled'?['off']:['off','low','high','max'];
    for(const model of clean.models){
      if(typeof model.id!=='string'||!model.id||models.length>=512)continue;
      models.push({provider:nativeProvider,model:model.id,providerLabel:'DeepSeek',modelLabel:String(model.name??model.id).slice(0,200),credentialReady:ready,adapter:'deepseek-native',reasoningEfforts:[...reasoningEfforts],...modalities(model)});
    }
  }
  const defaultRow=findRow(entries,'agent-default-model'),configuredDefault=defaultRow&&!defaultRow.disabled?defaultRow.config:null;
  const preferred=models.find(route=>route.credentialReady&&route.provider===(config.provider??configuredDefault?.provider)&&route.model===(config.model??configuredDefault?.model))??models.find(route=>route.credentialReady);
  return {providers,readyProviders,nativeProviders,readyNativeProviders,models,defaultRoute:preferred?{provider:preferred.provider,model:preferred.model}:null,warnings};
}
