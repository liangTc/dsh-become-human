const invalid=()=>{throw Object.assign(new Error('INVALID_CAPABILITY_SETTINGS'),{code:'INVALID_CAPABILITY_SETTINGS'});};
const fields=new Set(['sessionReadEnabled','sessionReadScope','sessionWriteEnabled','sessionWriteScope','readSessionIds','writeSessionIds','allowedSessionIds','browser']);
const scope=value=>{if(value!==undefined&&value!=='all'&&value!=='selected')invalid();return value??'selected';};

// An old signed policy used one list for both operations. Once either split
// field exists, a missing side is empty. Never widen it from a stale alias.
export function sessionGrantIds(policy,write=false){
  if(!policy)return [];
  const split=Object.hasOwn(policy,'readSessionIds')||Object.hasOwn(policy,'writeSessionIds');
  const field=split?(write?'writeSessionIds':'readSessionIds'):'allowedSessionIds';
  return Object.hasOwn(policy,field)?policy[field]:[];
}

function normalizeIds(value){
  if(!Array.isArray(value)||value.length>64||new Set(value).size!==value.length||
    value.some(id=>typeof id!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)))invalid();
  return [...value].sort();
}

export function normalizeSessionGrants(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.has(key)))invalid();
  for(const key of ['sessionReadEnabled','sessionWriteEnabled']){
    if(input[key]!==undefined&&typeof input[key]!=='boolean')invalid();
  }
  return {
    sessionReadEnabled:input.sessionReadEnabled===true,sessionReadScope:scope(input.sessionReadScope),
    sessionWriteEnabled:input.sessionWriteEnabled===true,sessionWriteScope:scope(input.sessionWriteScope),
    readSessionIds:normalizeIds(sessionGrantIds(input)),writeSessionIds:normalizeIds(sessionGrantIds(input,true)),
  };
}

export function sessionTargetInScope(settings,sessionId,write=false){
  return (write?settings.sessionWriteScope:settings.sessionReadScope)==='all'||
    sessionGrantIds(settings,write).includes(sessionId);
}

export function sessionScopeAvailable(settings,write=false,agentId){
  const enabled=write?settings?.sessionWriteEnabled:settings?.sessionReadEnabled;
  if(!enabled)return false;
  return (write?settings.sessionWriteScope:settings.sessionReadScope)==='all'||
    sessionGrantIds(settings,write).some(id=>id!==agentId);
}
