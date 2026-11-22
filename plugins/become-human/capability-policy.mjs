import {plain} from './capability-schema.mjs';
import {normalizeCustomMcpServers} from './capability-mcp-config.mjs';
import {normalizeSessionGrants} from './session-grants.mjs';
export const capabilityDefaults=Object.freeze({autonomy:{toolIds:[]},mcp:{bundledEnabled:true,servers:[]},bridge:normalizeSessionGrants(),limits:{maxToolCallsPerTurn:2,timeoutMs:60000,maxResultBytes:32768}});
const fail=()=>{throw new Error('INVALID_CAPABILITY_SETTINGS');};
const keys=(value,names)=>{if(!plain(value)||Object.keys(value).some(key=>!names.includes(key)))fail();};
const flag=value=>{if(typeof value!=='boolean')fail();return value;};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail();return value;};
const ids=value=>{if(!Array.isArray(value)||value.length>64||value.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/u.test(id))||new Set(value).size!==value.length)fail();return [...value];};
export function validateCapabilitySettings(input){
  keys(input,['mcp','bridge','limits','autonomy']);const m=input.mcp,b=input.bridge,l=input.limits??capabilityDefaults.limits;
  // Old signed policies may contain browser settings. Discard that retired
  // field when projecting them; no browser adapter or connection remains.
  keys(m,['bundledEnabled','servers']);keys(l,['maxToolCallsPerTurn','timeoutMs','maxResultBytes']);
  if(!plain(b))fail();flag(b.sessionReadEnabled);flag(b.sessionWriteEnabled);
  const autonomy=input.autonomy??{toolIds:[]};keys(autonomy,['toolIds']);const toolIds=ids(autonomy.toolIds??[]);
  return {autonomy:{toolIds},mcp:{bundledEnabled:flag(m.bundledEnabled),servers:normalizeCustomMcpServers(m.servers??[])},bridge:normalizeSessionGrants(b),limits:{maxToolCallsPerTurn:integer(l.maxToolCallsPerTurn,1,4),timeoutMs:integer(l.timeoutMs,1000,120000),maxResultBytes:integer(l.maxResultBytes,8192,65536)}};
}
