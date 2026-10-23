import {createHash} from 'node:crypto';
import path from 'node:path';
import {assertCapabilitySchema,plain} from './capability-schema.mjs';

const fail=code=>{throw new Error(code);};
const keys=(value,names)=>{if(!plain(value)||Object.keys(value).some(key=>!names.includes(key)))fail('INVALID_CUSTOM_MCP_SETTINGS');};
const text=(value,max,{empty=false,multiline=false}={})=>{if(typeof value!=='string'||value.length>max||!empty&&!value.trim()||(multiline?/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u:/[\u0000-\u001f]/u).test(value))fail('INVALID_CUSTOM_MCP_SETTINGS');return value;};
const flag=(value,fallback=false)=>{if(value===undefined)return fallback;if(typeof value!=='boolean')fail('INVALID_CUSTOM_MCP_SETTINGS');return value;};
const identifier=value=>{if(typeof value!=='string'||!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/u.test(value))fail('INVALID_CUSTOM_MCP_SETTINGS');return value;};
function argument(value){
  const result=text(value,4096,{empty:true});
  // Arguments are readable/exported configuration. This catches common secret
  // forms, not every possible secret; authentication belongs in MCP_* refs.
  if(/^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|password|passwd|secret|client[-_]?secret|credential)(?:=|$)/iu.test(result)||/\b(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|client[-_]?secret)["']?\s*[:=]/iu.test(result)||/\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})/u.test(result))fail('MCP_SECRET_ARGUMENT_FORBIDDEN');
  for(const match of result.matchAll(/https?:\/\/[^\s"'<>]+/gu)){
    let url;try{url=new URL(match[0]);}catch{continue;}
    if(url.username||url.password||[...url.searchParams.keys()].some(key=>/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|auth|authorization|password|secret|key)$/iu.test(key)))fail('MCP_SECRET_ARGUMENT_FORBIDDEN');
  }
  return result;
}
const references=(value,{headers=false}={})=>{
  if(value===undefined)return {};if(!plain(value)||Object.keys(value).length>16)fail('INVALID_CUSTOM_MCP_SETTINGS');
  const result={};for(const [key,ref] of Object.entries(value)){
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(key)||['__proto__','constructor','prototype'].includes(key)||headers&&/^(cookie|host|origin|connection|content-length|content-type|accept|mcp-.*|proxy-.*)$/iu.test(key)||typeof ref!=='string'||!/^MCP_[A-Z0-9_]{1,100}$/u.test(ref))fail('INVALID_MCP_ENV_REFERENCE');
    result[key]=ref;
  }return result;
};
function canonical(value,depth=0){
  if(depth>16)fail('MCP_TOOL_SCHEMA_TOO_COMPLEX');
  if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
  if(plain(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]));
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return value;
  fail('INVALID_CUSTOM_MCP_SETTINGS');
}
export const customMcpHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function describeCustomMcpTool(tool){
  if(!plain(tool)||typeof tool.name!=='string'||!/^[a-zA-Z0-9_.:-]{1,128}$/u.test(tool.name))fail('MCP_INVALID_TOOL_LIST');
  const description=typeof tool.description==='string'?tool.description.slice(0,3000):'',inputSchema=tool.inputSchema;
  if(!plain(inputSchema)||Buffer.byteLength(JSON.stringify(inputSchema))>16384)fail('MCP_INVALID_TOOL_LIST');
  const snapshot={name:tool.name,description,inputSchema,outputSchema:tool.outputSchema??null,taskRequired:tool.execution?.taskSupport==='required'};
  let unsupportedReason=null;try{assertCapabilitySchema(inputSchema);if(inputSchema.type!=='object')unsupportedReason='MCP_OBJECT_INPUT_REQUIRED';}catch{unsupportedReason='MCP_UNSUPPORTED_INPUT_SCHEMA';}
  if(snapshot.taskRequired)unsupportedReason='MCP_ASYNC_TASK_UNSUPPORTED';
  return {name:tool.name,description,inputSchema:structuredClone(inputSchema),schemaHash:customMcpHash(snapshot),supported:unsupportedReason===null,unsupportedReason,annotations:{readOnlyHint:tool.annotations?.readOnlyHint===true,destructiveHint:tool.annotations?.destructiveHint===true},enabled:false,effect:'write'};
}
function toolGrant(value){
  keys(value,['name','description','inputSchema','schemaHash','effect','enabled']);
  const name=text(value.name,128);if(!/^[a-zA-Z0-9_.:-]{1,128}$/u.test(name)||typeof value.schemaHash!=='string'||!/^[0-9a-f]{64}$/u.test(value.schemaHash)||!['read','write'].includes(value.effect))fail('INVALID_CUSTOM_MCP_SETTINGS');
  assertCapabilitySchema(value.inputSchema);if(value.inputSchema.type!=='object')fail('MCP_OBJECT_INPUT_REQUIRED');
  return {name,description:text(value.description??'',3000,{empty:true,multiline:true}),inputSchema:structuredClone(value.inputSchema),schemaHash:value.schemaHash,effect:value.effect,enabled:flag(value.enabled)};
}
export function normalizeCustomMcpServer(value,{discovery=false}={}){
  keys(value,['id','name','enabled','transport','command','args','cwd','env','url','headerEnv','timeoutMs','tools']);
  const id=identifier(value.id),name=text(value.name??id,80),enabled=flag(value.enabled),timeoutMs=value.timeoutMs??25000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000||!['stdio','http'].includes(value.transport))fail('INVALID_CUSTOM_MCP_SETTINGS');
  const result={id,name,enabled,transport:value.transport,timeoutMs};
  if(value.transport==='stdio'){
    const command=text(value.command,2048);if(!path.isAbsolute(command))fail('MCP_ABSOLUTE_COMMAND_REQUIRED');
    if(/\.(?:bat|cmd|ps1)$/iu.test(command))fail('MCP_EXECUTABLE_REQUIRED');
    if(value.args!==undefined&&(!Array.isArray(value.args)||value.args.length>32))fail('INVALID_CUSTOM_MCP_SETTINGS');
    result.command=command;result.args=(value.args??[]).map(argument);
    result.cwd=value.cwd?text(value.cwd,2048):path.dirname(command);if(!path.isAbsolute(result.cwd))fail('MCP_ABSOLUTE_CWD_REQUIRED');
    result.env=references(value.env);
  }else{
    let url;try{url=new URL(text(value.url,2048));}catch{fail('INVALID_MCP_URL');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))fail('INVALID_MCP_URL');
    result.url=url.href;result.headerEnv=references(value.headerEnv,{headers:true});
  }
  if(value.tools!==undefined&&(!Array.isArray(value.tools)||value.tools.length>32))fail('INVALID_CUSTOM_MCP_SETTINGS');
  result.tools=discovery?[]:(value.tools??[]).map(toolGrant);if(new Set(result.tools.map(tool=>tool.name)).size!==result.tools.length)fail('DUPLICATE_MCP_TOOL');
  if(Buffer.byteLength(JSON.stringify(result))>65536)fail('MCP_SERVER_SETTINGS_TOO_LARGE');return result;
}
export function normalizeCustomMcpServers(value=[]){
  if(!Array.isArray(value)||value.length>8)fail('INVALID_CUSTOM_MCP_SETTINGS');
  const servers=value.map(server=>normalizeCustomMcpServer(server));if(new Set(servers.map(server=>server.id)).size!==servers.length)fail('DUPLICATE_MCP_SERVER');
  if(Buffer.byteLength(JSON.stringify(servers))>131072)fail('MCP_SETTINGS_TOO_LARGE');return servers;
}
export function resolveCustomMcpReferences(mapping,{headers=false}={}){
  return Object.fromEntries(Object.entries(mapping??{}).map(([key,ref])=>{
    const value=process.env[ref];if(typeof value!=='string'||!value||value.length>8192||headers&&/[\r\n\u0000]/u.test(value))fail('MCP_ENV_REFERENCE_MISSING');return [key,value];
  }));
}
