export const PRESET_FILE_SCHEMA='human-config-preset-v1';
export const PRESET_CATALOG_SCHEMA='human-config-preset-catalog-v1';
export const PRESET_MAX_BYTES=64*1024;
export const PERSONA_PRESET_KEYS=Object.freeze(['name','role','corePrompt','interests','goals']);
export const AUTONOMY_BUDGET_PRESET_KEYS=Object.freeze(['quotaEnabled','tokenQuotaEnabled','requestQuotaEnabled','roundQuotaEnabled','tokenLimit','requestLimit','roundLimit','budgetWindow','roundTimeoutMs']);

const kinds=new Set(['persona','autonomy-budget']);
const fail=code=>{throw new Error(code);};
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
function shape(value,allowed,required,code){
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!allowed.includes(key)||descriptors[key].get||descriptors[key].set)||required.some(key=>!own(value,key)))fail(code);
  return value;
}
function text(value,max,required,code){if(typeof value!=='string'||value.length>max||required&&!value.trim())fail(code);return value.trim();}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_PRESET_CONFIGURATION');return value;}
function kind(value,expected){if(!kinds.has(value)||expected!==undefined&&!kinds.has(expected))fail('INVALID_PRESET_KIND');if(expected!==undefined&&value!==expected)fail('PRESET_KIND_MISMATCH');return value;}
function metadata(value,{catalog=false}={}){
  const result={};
  if(catalog||own(value,'name'))result.name=text(value.name,80,true,'INVALID_PRESET_METADATA');
  if(own(value,'description'))result.description=text(value.description,500,false,'INVALID_PRESET_METADATA');
  return result;
}
function bounded(value){const encoded=JSON.stringify(value,null,2)+'\n';if(new TextEncoder().encode(encoded).byteLength>PRESET_MAX_BYTES)fail('PRESET_FILE_TOO_LARGE');return encoded;}

// Only these five fields can be merged into a profile. Owner details,
// credentials, permissions and session state never enter the returned object.
export function validatePersonaConfig(input){
  shape(input,PERSONA_PRESET_KEYS,PERSONA_PRESET_KEYS,'INVALID_PRESET_CONFIGURATION');
  return {name:text(input.name,64,true,'INVALID_PRESET_CONFIGURATION'),role:text(input.role,160,false,'INVALID_PRESET_CONFIGURATION'),corePrompt:text(input.corePrompt,512,true,'INVALID_PRESET_CONFIGURATION'),interests:text(input.interests,500,false,'INVALID_PRESET_CONFIGURATION'),goals:text(input.goals,800,false,'INVALID_PRESET_CONFIGURATION')};
}

// Applying a budget does not enable autonomous behavior or change wake cadence,
// contact settings, sources, timezone, grants, or any execution permission.
export function validateAutonomyBudgetConfig(input){
  shape(input,AUTONOMY_BUDGET_PRESET_KEYS,AUTONOMY_BUDGET_PRESET_KEYS,'INVALID_PRESET_CONFIGURATION');
  const output={};for(const key of ['quotaEnabled','tokenQuotaEnabled','requestQuotaEnabled','roundQuotaEnabled']){if(typeof input[key]!=='boolean')fail('INVALID_PRESET_CONFIGURATION');output[key]=input[key];}
  output.tokenLimit=integer(input.tokenLimit,1024,20000000);output.requestLimit=integer(input.requestLimit,1,10000);output.roundLimit=integer(input.roundLimit,1,10000);
  if(!['utc-day','local-day','rolling-day'].includes(input.budgetWindow))fail('INVALID_PRESET_CONFIGURATION');
  output.budgetWindow=input.budgetWindow;output.roundTimeoutMs=integer(input.roundTimeoutMs,1000,3600000);return output;
}
function extract(input,keys,validate){
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('INVALID_PRESET_CONFIGURATION');
  const output={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||descriptor.get||descriptor.set)fail('INVALID_PRESET_CONFIGURATION');output[key]=descriptor.value;}return validate(output);
}
// Explicitly select fields from local application state before an export.
// File imports always use the strict validators and reject extra config keys.
export function extractPersonaConfig(profile){return extract(profile,PERSONA_PRESET_KEYS,validatePersonaConfig);}
export function extractAutonomyBudgetConfig(settings){return extract(settings,AUTONOMY_BUDGET_PRESET_KEYS,validateAutonomyBudgetConfig);}
function configuration(type,input){return type==='persona'?validatePersonaConfig(input):validateAutonomyBudgetConfig(input);}

// Catalog data is passed by the caller, allowing the same functions in a
// browser JSON import and in local tooling. This module has no filesystem API.
export function listPresetCatalog(catalog,expectedKind){
  shape(catalog,['schema','kind','presets'],['schema','kind','presets'],'INVALID_PRESET_CATALOG');
  if(catalog.schema!==PRESET_CATALOG_SCHEMA||!Array.isArray(catalog.presets)||!catalog.presets.length||catalog.presets.length>32)fail('INVALID_PRESET_CATALOG');
  const type=kind(catalog.kind,expectedKind),ids=new Set();
  const entries=catalog.presets.map(entry=>{
    shape(entry,['id','name','description','config'],['id','name','config'],'INVALID_PRESET_CATALOG');
    if(typeof entry.id!=='string'||entry.id.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(entry.id)||ids.has(entry.id))fail('INVALID_PRESET_CATALOG');
    ids.add(entry.id);return {id:entry.id,...metadata(entry,{catalog:true}),config:configuration(type,entry.config)};
  });
  bounded({schema:PRESET_CATALOG_SCHEMA,kind:type,presets:entries});return entries;
}
export function getPresetConfig(catalog,id,expectedKind){
  const entries=listPresetCatalog(catalog,expectedKind);if(typeof id!=='string')fail('PRESET_NOT_FOUND');const entry=entries.find(item=>item.id===id);if(!entry)fail('PRESET_NOT_FOUND');return entry.config;
}
export function parsePresetFile(source,expectedKind){
  if(typeof source!=='string')fail('INVALID_PRESET_FILE');if(new TextEncoder().encode(source).byteLength>PRESET_MAX_BYTES)fail('PRESET_FILE_TOO_LARGE');
  let value;try{value=JSON.parse(source.charCodeAt(0)===0xfeff?source.slice(1):source);}catch{fail('INVALID_PRESET_FILE');}
  shape(value,['schema','kind','name','description','config'],['schema','kind','config'],'INVALID_PRESET_FILE');
  if(value.schema!==PRESET_FILE_SCHEMA)fail('INVALID_PRESET_FILE');const type=kind(value.kind,expectedKind);
  return {schema:PRESET_FILE_SCHEMA,kind:type,...metadata(value),config:configuration(type,value.config)};
}
export function exportPresetFile(type,input,details={}){
  kind(type);shape(details,['name','description'],[],'INVALID_PRESET_METADATA');
  return bounded({schema:PRESET_FILE_SCHEMA,kind:type,...metadata(details),config:configuration(type,input)});
}
