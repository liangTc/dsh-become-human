import {plain} from './capability-schema.mjs';
import {normalizeCustomMcpServers} from './capability-mcp-config.mjs';
export const capabilityDefaults=Object.freeze({mcp:{bundledEnabled:true,servers:[]},bridge:{sessionReadEnabled:false,sessionReadScope:'selected',sessionWriteEnabled:false,sessionWriteScope:'selected',allowedSessionIds:[]},limits:{maxToolCallsPerTurn:2,timeoutMs:60000,maxResultBytes:32768}});
const fail=()=>{throw new Error('INVALID_CAPABILITY_SETTINGS');};
const keys=(value,names)=>{if(!plain(value)||Object.keys(value).some(key=>!names.includes(key)))fail();};
const flag=value=>{if(typeof value!=='boolean')fail();return value;};
const sessionScope=value=>{if(value!==undefined&&!['selected','all'].includes(value))fail();return value??'selected';};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail();return value;};
const ids=value=>{if(!Array.isArray(value)||value.length>64||value.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/u.test(id))||new Set(value).size!==value.length)fail();return [...value];};
export function validateCapabilitySettings(input){
  keys(input,['mcp','bridge','limits']);const m=input.mcp,b=input.bridge,l=input.limits??capabilityDefaults.limits;
  // Old signed policies may contain browser settings. Discard that retired
  // field when projecting them; no browser adapter or connection remains.
  keys(m,['bundledEnabled','servers']);keys(b,['sessionReadEnabled','sessionReadScope','sessionWriteEnabled','sessionWriteScope','allowedSessionIds','browser']);keys(l,['maxToolCallsPerTurn','timeoutMs','maxResultBytes']);
  return {mcp:{bundledEnabled:flag(m.bundledEnabled),servers:normalizeCustomMcpServers(m.servers??[])},bridge:{sessionReadEnabled:flag(b.sessionReadEnabled),sessionReadScope:sessionScope(b.sessionReadScope),sessionWriteEnabled:flag(b.sessionWriteEnabled),sessionWriteScope:sessionScope(b.sessionWriteScope),allowedSessionIds:ids(b.allowedSessionIds)},limits:{maxToolCallsPerTurn:integer(l.maxToolCallsPerTurn,1,4),timeoutMs:integer(l.timeoutMs,1000,120000),maxResultBytes:integer(l.maxResultBytes,8192,65536)}};
}
