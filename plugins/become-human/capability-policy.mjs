import {plain} from './capability-schema.mjs';
import {normalizeCustomMcpServers} from './capability-mcp-config.mjs';
export const capabilityDefaults=Object.freeze({mcp:{bundledEnabled:true,servers:[]},bridge:{sessionReadEnabled:false,sessionReadScope:'selected',sessionWriteEnabled:false,sessionWriteScope:'selected',allowedSessionIds:[],browser:{enabled:false,endpoint:'http://127.0.0.1:9222',allowedOrigins:[],allowedTargetIds:[]}},limits:{maxToolCallsPerTurn:2,timeoutMs:60000,maxResultBytes:32768}});
const fail=()=>{throw new Error('INVALID_CAPABILITY_SETTINGS');};
const keys=(value,names)=>{if(!plain(value)||Object.keys(value).some(key=>!names.includes(key)))fail();};
const flag=value=>{if(typeof value!=='boolean')fail();return value;};
const sessionScope=value=>{if(value!==undefined&&!['selected','all'].includes(value))fail();return value??'selected';};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail();return value;};
const ids=value=>{if(!Array.isArray(value)||value.length>64||value.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/u.test(id))||new Set(value).size!==value.length)fail();return [...value];};
export function validateCapabilitySettings(input){
  keys(input,['mcp','bridge','limits']);const m=input.mcp,b=input.bridge,l=input.limits??capabilityDefaults.limits;
  keys(m,['bundledEnabled','servers']);keys(b,['sessionReadEnabled','sessionReadScope','sessionWriteEnabled','sessionWriteScope','allowedSessionIds','browser']);keys(b.browser,['enabled','endpoint','allowedOrigins','allowedTargetIds']);keys(l,['maxToolCallsPerTurn','timeoutMs','maxResultBytes']);
  let endpoint;try{endpoint=new URL(b.browser.endpoint);}catch{fail();}
  if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')fail();
  if(!Array.isArray(b.browser.allowedOrigins)||b.browser.allowedOrigins.length>32)fail();
  const origins=b.browser.allowedOrigins.map(value=>{let url;try{url=new URL(value);}catch{fail();}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin==='null')fail();return url.origin;});
  return {mcp:{bundledEnabled:flag(m.bundledEnabled),servers:normalizeCustomMcpServers(m.servers??[])},bridge:{sessionReadEnabled:flag(b.sessionReadEnabled),sessionReadScope:sessionScope(b.sessionReadScope),sessionWriteEnabled:flag(b.sessionWriteEnabled),sessionWriteScope:sessionScope(b.sessionWriteScope),allowedSessionIds:ids(b.allowedSessionIds),browser:{enabled:flag(b.browser.enabled),endpoint:endpoint.origin,allowedOrigins:[...new Set(origins)],allowedTargetIds:ids(b.browser.allowedTargetIds??[])}},limits:{maxToolCallsPerTurn:integer(l.maxToolCallsPerTurn,1,4),timeoutMs:integer(l.timeoutMs,1000,120000),maxResultBytes:integer(l.maxResultBytes,8192,65536)}};
}
