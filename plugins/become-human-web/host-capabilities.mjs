import {createHash} from 'node:crypto';
import {createBrowserCapabilities,normalizeBrowserSettings} from './browser-capabilities.mjs';

const error=code=>Object.assign(new Error(code),{code});
const fail=code=>{throw error(code);};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const identifier=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))fail('INVALID_CAPABILITY_INPUT');return value;};
const only=(input,keys)=>{if(!plain(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('INVALID_CAPABILITY_INPUT');};
const number=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const boundedText=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const unknown=(cause,receipt)=>Object.assign(error('CAPABILITY_OUTCOME_UNKNOWN'),{cause,...(receipt?{receipt}: {})});
const sessionScope=value=>{if(value!==undefined&&!['selected','all'].includes(value))fail('INVALID_CAPABILITY_SETTINGS');return value??'selected';};
const ordinarySession=value=>plain(value)&&value.origin===undefined&&!(Number(value.delegationDepth)>0);
const visibleChatEvent=event=>{
  if(event?.surfaceOp!=='append'||!['user/message','assistant/message'].includes(event?.type))return false;
  const message=event.type==='assistant/message'?event.data?.message:event.data;
  // DSH's ordinary user producer is `user`. Other user-role producers are
  // injected context (instructions, goals, compaction, relay), not owner chat.
  if(event.type==='user/message'&&message?.source?.kind!=='user')return false;
  return typeof message?.content==='string'?!!message.content:Array.isArray(message?.content)&&message.content.some(part=>part?.type==='text'&&typeof part.text==='string'&&!!part.text);
};
const hostRead=async operation=>{
  try{return await operation();}catch(cause){
    const code=cause?.code;
    if(['DSH_SESSION_CONTROLLER_UNAVAILABLE','CAPABILITY_POLICY_CHANGED','CAPABILITY_BRIDGE_CLOSED'].includes(code))fail(code);
    if(cause?.constructor?.name==='ApiSessionNotFound'||['session/not-found','SESSION_QUERY_SESSION_NOT_FOUND'].includes(code))fail('DSH_SESSION_NOT_FOUND');
    if(['session/agent-busy','subagent/unauthorized','subagent/not-found'].includes(code))fail('DSH_SESSION_NOT_VISIBLE');
    if(['gateway/bad-request','SESSION_QUERY_INVALID_REQUEST'].includes(code))fail('INVALID_CAPABILITY_INPUT');
    if(['gateway/cancelled','SESSION_QUERY_ABORTED'].includes(code))fail('CAPABILITY_CANCELLED');
    fail('DSH_SESSION_READ_UNAVAILABLE');
  }
};

export function normalizeHostCapabilitySettings(input={}){
  only(input,['sessionReadEnabled','sessionReadScope','sessionWriteEnabled','sessionWriteScope','allowedSessionIds','browser']);
  for(const key of ['sessionReadEnabled','sessionWriteEnabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')fail('INVALID_CAPABILITY_SETTINGS');
  const ids=input.allowedSessionIds??[];if(!Array.isArray(ids)||ids.length>64)fail('INVALID_CAPABILITY_SETTINGS');
  return {sessionReadEnabled:input.sessionReadEnabled===true,sessionReadScope:sessionScope(input.sessionReadScope),sessionWriteEnabled:input.sessionWriteEnabled===true,sessionWriteScope:sessionScope(input.sessionWriteScope),allowedSessionIds:[...new Set(ids.map(identifier))].sort(),browser:normalizeBrowserSettings(input.browser??{})};
}

// Direct Host APIs only. Reads do not resolve/create an Agent, and no operation
// addresses the Human's own durable Session. External sessions remain external.
export function createHostCapabilities(ctx,{getHumanSessionId,home}={}){
  if(typeof getHumanSessionId!=='function')fail('INVALID_CAPABILITY_BRIDGE');
  const browser=createBrowserCapabilities();let settings=normalizeHostCapabilitySettings(),fingerprint=JSON.stringify(settings),revision=null,closed=false;
  const active=new Set();
  const controller=()=>{let value;try{value=ctx?.sessionController??ctx?.get?.('sessionController');}catch{}if(!value)fail('DSH_SESSION_CONTROLLER_UNAVAILABLE');return value;};
  const ordinaryHostSession=value=>{
    if(!ordinarySession(value))return false;
    const parentId=value.parentSessionId??value.parentSession;if(!parentId)return true;
    let agents;try{agents=ctx?.agents??ctx?.get?.('agents');}catch{}
    const child=agents?.get?.(value.sessionId??value.id),parent=agents?.get?.(parentId);
    return !(child&&parent&&typeof agents.isOwnedBy==='function'&&agents.isOwnedBy(child.id,parent));
  };
  const humanSession=async()=>{const id=await getHumanSessionId();if(typeof id!=='string'||!id)fail('HUMAN_SESSION_UNAVAILABLE');return id;};
  const scopeFor=write=>write?settings.sessionWriteScope:settings.sessionReadScope;
  const assertAllowed=async(sessionId,write)=>{
    const human=await humanSession();if(sessionId===human)fail('HUMAN_SESSION_TARGET_FORBIDDEN');
    if(!(write?settings.sessionWriteEnabled:settings.sessionReadEnabled))fail('CAPABILITY_DISABLED');
    if(scopeFor(write)!=='all'&&!settings.allowedSessionIds.includes(sessionId))fail('CAPABILITY_SCOPE_DENIED');
  };
  const scopeSignal=signal=>{const aborter=new AbortController(),abort=()=>aborter.abort(signal.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});active.add(aborter);return {signal:aborter.signal,release:()=>{active.delete(aborter);signal?.removeEventListener('abort',abort);}};};
  const assertCurrent=(signal,expected)=>{signal.throwIfAborted();if(closed)fail('CAPABILITY_BRIDGE_CLOSED');if(expected!==fingerprint)fail('CAPABILITY_POLICY_CHANGED');};
  // `all` is a live Host visibility rule, never a wildcard session identifier.
  // A remembered/approved ID must still exist in the ordinary Session catalog at
  // execution time. Neither selected nor all mode may promote a hidden child.
  async function visibleSessions(signal,expected){
    const human=await humanSession();assertCurrent(signal,expected);
    const result=await hostRead(()=>controller().list({},signal));assertCurrent(signal,expected);
    if(!Array.isArray(result?.items))fail('DSH_SESSION_READ_UNAVAILABLE');
    return result.items.filter(row=>ordinaryHostSession(row)&&typeof row.sessionId==='string'&&row.sessionId!==human);
  }
  async function inspectAllowed(sessionId,write,signal,expected){
    await assertAllowed(sessionId,write);assertCurrent(signal,expected);
    const rows=await visibleSessions(signal,expected);
    if(!rows.some(row=>row.sessionId===sessionId))fail('DSH_SESSION_NOT_VISIBLE');
    const inspection=await hostRead(()=>controller().inspect(sessionId,signal));assertCurrent(signal,expected);
    if(!ordinaryHostSession(inspection?.meta))fail('CAPABILITY_SCOPE_DENIED');
    if(inspection.meta.id!==sessionId)fail('DSH_SESSION_NOT_VISIBLE');
    await assertAllowed(sessionId,write);assertCurrent(signal,expected);return inspection;
  }
  async function sessionList(input,signal,expected){
    only(input,['limit']);const limit=input.limit===undefined?25:number(input.limit,1,100);
    if(!settings.sessionReadEnabled)fail('CAPABILITY_DISABLED');
    const rows=(await visibleSessions(signal,expected)).filter(row=>scopeFor(false)==='all'||settings.allowedSessionIds.includes(row.sessionId));
    const items=[];let used=0;for(const row of rows.slice(0,limit)){const item={sessionId:row.sessionId,updatedAt:row.updatedAt,running:row.running===true,agentAvailable:row.agentAvailable===true,blank:row.blank===true,...(row.cwd?{cwd:boundedText(row.cwd,256)}:{})};used+=JSON.stringify(item).length;if(used>12000)break;items.push(item);}
    return {items,total:rows.length,hasMore:rows.length>items.length,accessScope:settings.sessionReadScope,sessionMode:'external-resources',activatedAgent:false};
  }
  async function sessionRead(input,signal,expected){
    only(input,['sessionId','limit','beforeSeq','throughSeq']);const sessionId=identifier(input.sessionId),limit=input.limit===undefined?20:number(input.limit,1,50);
    if(input.beforeSeq!==undefined)number(input.beforeSeq,0,Number.MAX_SAFE_INTEGER);
    if(input.throughSeq!==undefined)number(input.throughSeq,-1,Number.MAX_SAFE_INTEGER);
    const inspection=await inspectAllowed(sessionId,false,signal,expected),service=controller();
    const currentSeq=inspection?.events?.at(-1)?.seq??-1,throughSeq=input.throughSeq??currentSeq;
    if(throughSeq>currentSeq)fail('INVALID_CAPABILITY_INPUT');
    const page=await hostRead(()=>service.page({address:{kind:'session',sessionId},throughSeq,...(input.beforeSeq===undefined?{}:{beforeSeq:input.beforeSeq}),maxMessages:limit},signal));assertCurrent(signal,expected);
    // Visibility may have changed during persistence I/O. Do not release text
    // from an identity that disappeared or became a child while reading it.
    if(!(await visibleSessions(signal,expected)).some(row=>row.sessionId===sessionId))fail('DSH_SESSION_NOT_VISIBLE');
    await assertAllowed(sessionId,false);assertCurrent(signal,expected);
    let used=0,truncated=false,budgetCut=null;const messages=[];
    for(const record of [...(page?.records??[])].reverse()){
      const event=record?.event;if(!visibleChatEvent(event))continue;
      const message=event.type==='assistant/message'?event.data?.message:event.data;
      const content=message?.content;const full=typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n'):'';
      if(!full)continue;const text=full.slice(0,Math.min(8000,Math.max(0,20000-used)));if(!text){truncated=true;budgetCut=messages[0]?.seq??event.seq+1;break;}used+=text.length;
      if(text.length<full.length)truncated=true;
      messages.unshift({seq:event.seq,time:event.time,role:event.type==='user/message'?'user':'assistant',sourceKind:message?.source?.kind??'model',text,...(text.length<full.length?{truncated:true}:{}),...(event.data?.interrupted===true?{interrupted:true}:{})});
    }
    // Cursor addresses the raw log cut actually covered, not a clipped message
    // body. Text clipping never invents another page. Inspect and page share the
    // same explicit throughSeq, so later appends do not move this history cut.
    const firstSeq=budgetCut??page?.records?.[0]?.event?.seq??Math.min(input.beforeSeq??throughSeq+1,throughSeq+1);
    const hasMore=(inspection?.events??[]).some(event=>event.seq<firstSeq&&event.seq<=throughSeq&&visibleChatEvent(event));
    return {sessionId,throughSeq,messages,hasMore,nextBeforeSeq:hasMore&&Number.isSafeInteger(firstSeq)?firstSeq:null,truncated,activatedAgent:false,source:'external-dsh-session',untrustedContent:true};
  }
  async function sessionWrite(operation,input,context,signal,expected){
    only(input,operation==='dsh-session-prompt'?['sessionId','text']:['sessionId']);const sessionId=identifier(input.sessionId);
    if(operation==='dsh-session-prompt'&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000))fail('INVALID_CAPABILITY_INPUT');
    if(typeof context?.agent!=='string'||typeof context?.jobId!=='string'||!context.agent||!context.jobId)fail('INVALID_CAPABILITY_CONTEXT');
    await inspectAllowed(sessionId,true,signal,expected);assertCurrent(signal,expected);
    const requestId='bh-'+createHash('sha256').update(context.agent+'\n'+context.jobId+'\n'+(context.requestId??'')).digest('hex').slice(0,48);
    const service=controller(),receipt={operation,sessionId,requestId,at:Date.now()};let dispatched=false;
    try{
      assertCurrent(signal,expected);dispatched=true;
      if(operation==='dsh-session-prompt'){
        const result=await service.prompt({sessionId,requestId,mode:'queue',content:[{type:'text',text:input.text}]},signal);
        assertCurrent(signal,expected);if(result?.accepted!==true)throw unknown(undefined,receipt);
        return {accepted:true,status:'accepted-not-completed',receipt,metadata:{externalModel:true,accounting:'owned-by-external-session',createsSession:false},meaning:'目标会话已接收；不代表任务执行完成，模型工作由目标会话独立管理。'};
      }
      const result=await service.cancel({sessionId});assertCurrent(signal,expected);if(result?.accepted!==true)throw unknown(undefined,receipt);
      // A cancel acknowledgement is not a stopped/completed receipt. Observe the
      // current state before declaring a verified cancellation operation.
      const until=Date.now()+4000;
      while(true){
        const rows=await service.list({},signal);assertCurrent(signal,expected);const target=rows?.items?.find(row=>row.sessionId===sessionId);
        if(target&&target.running===false)return {accepted:true,status:'cancellation-requested-and-observed-idle',receipt,observedAt:Date.now(),pendingInboxRetained:true,taskCompleted:false,metadata:{externalModel:true},meaning:'已请求取消，并观察到目标会话当前空闲；不表示原任务成功或后续队列已停止。'};
        if(Date.now()>=until)throw unknown(undefined,receipt);
        await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??error('CAPABILITY_CANCELLED'));},timer=setTimeout(done,200);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
      }
    }catch(cause){if(dispatched&&cause?.code!=='CAPABILITY_OUTCOME_UNKNOWN')throw unknown(cause,receipt);throw cause;}
  }
  return {
    configure(input,{revision:nextRevision}={}){
      if(closed)fail('CAPABILITY_BRIDGE_CLOSED');const next=normalizeHostCapabilitySettings(input),nextFingerprint=JSON.stringify(next);
      if(nextFingerprint!==fingerprint||(nextRevision!==undefined&&nextRevision!==revision)){for(const aborter of active)aborter.abort(error('CAPABILITY_POLICY_CHANGED'));settings=next;fingerprint=nextFingerprint;revision=nextRevision??revision;browser.configure(settings.browser,{revision});}
      return this.status();
    },
    status(){let available=false;try{available=!!controller();}catch{}return {backend:'host-bridge',closed,session:{available,readEnabled:settings.sessionReadEnabled,readScope:settings.sessionReadScope,writeEnabled:settings.sessionWriteEnabled,writeScope:settings.sessionWriteScope,allowedSessionIds:[...settings.allowedSessionIds],coldReads:true,externalModelOnPrompt:true,dynamicHostVisibility:true,excludesHumanSession:true,excludesSubagents:true},browser:browser.status()};},
    async handle({operation,input,context}={},signal=new AbortController().signal){
      if(closed)fail('CAPABILITY_BRIDGE_CLOSED');const scoped=scopeSignal(signal),expected=fingerprint;
      try{assertCurrent(scoped.signal,expected);
        if(operation==='dsh-session-list')return await sessionList(input,scoped.signal,expected);
        if(operation==='dsh-session-read')return await sessionRead(input,scoped.signal,expected);
        if(['dsh-session-prompt','dsh-session-cancel'].includes(operation))return await sessionWrite(operation,input,context,scoped.signal,expected);
        if(typeof operation==='string'&&operation.startsWith('browser-tab-'))return await browser.handle({operation,input,context},scoped.signal);
        fail('CAPABILITY_NOT_FOUND');
      }finally{scoped.release();}
    },
    async close(){if(closed)return;closed=true;for(const aborter of active)aborter.abort(error('CAPABILITY_BRIDGE_CLOSED'));active.clear();await browser.close();},
  };
}
