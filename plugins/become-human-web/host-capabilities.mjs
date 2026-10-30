import {createHash} from 'node:crypto';

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
const chatText=event=>{
  const message=event.type==='assistant/message'?event.data?.message:event.data,content=message?.content;
  return typeof content==='string'?content:content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
};
const observationRecords=events=>{
  if(!Array.isArray(events))fail('DSH_SESSION_READ_UNAVAILABLE');
  const records=events.filter(visibleChatEvent).map(event=>{
    if(!Number.isSafeInteger(event.seq)||event.seq<0)fail('DSH_SESSION_READ_UNAVAILABLE');
    const message=event.type==='assistant/message'?event.data?.message:event.data;
    return {seq:event.seq,time:event.time,role:event.type==='user/message'?'user':'assistant',text:chatText(event),sourceKind:message?.source?.kind??'model'};
  }).sort((a,b)=>a.seq-b.seq);
  if(records.some((row,index)=>index>0&&row.seq===records[index-1].seq))fail('DSH_SESSION_READ_UNAVAILABLE');
  return records;
};
const observationDigest=(sessionId,records,throughSeq)=>{
  const hash=createHash('sha256').update(JSON.stringify({version:1,sessionId})+'\n');
  for(const row of records){if(row.seq>throughSeq)break;hash.update(JSON.stringify(row)+'\n');}
  return hash.digest('hex');
};
const sensitiveObservation=text=>/(?:\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|secret|authorization|cookie|密码|密钥|令牌)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,})/iu.test(text);
const clipObservation=(text,limit)=>{let end=Math.min(text.length,limit);if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]??''))end--;return text.slice(0,end);};
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

export function activeSessionTurn(events){
  if(!Array.isArray(events))return null;
  const start=events.findLast(event=>event.type==='turn/start');
  if(!start||!Number.isSafeInteger(start.seq)||start.seq<0||!Number.isSafeInteger(start.data?.turn)||start.data.turn<1)return null;
  if(events.some(event=>event.seq>start.seq&&event.type==='turn/end'&&event.data?.turn===start.data.turn))return null;
  return {turn:start.data.turn,turnStartSeq:start.seq};
}

export function normalizeHostCapabilitySettings(input={}){
  only(input,['sessionReadEnabled','sessionReadScope','sessionWriteEnabled','sessionWriteScope','allowedSessionIds','browser']);
  for(const key of ['sessionReadEnabled','sessionWriteEnabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')fail('INVALID_CAPABILITY_SETTINGS');
  const ids=input.allowedSessionIds??[];if(!Array.isArray(ids)||ids.length>64)fail('INVALID_CAPABILITY_SETTINGS');
  return {sessionReadEnabled:input.sessionReadEnabled===true,sessionReadScope:sessionScope(input.sessionReadScope),sessionWriteEnabled:input.sessionWriteEnabled===true,sessionWriteScope:sessionScope(input.sessionWriteScope),allowedSessionIds:[...new Set(ids.map(identifier))].sort()};
}

// Direct Host APIs only. Reads do not resolve/create an Agent, and no operation
// addresses the Human's own durable Session. External sessions remain external.
export function createHostCapabilities(ctx,{getHumanSessionId,home}={}){
  if(typeof getHumanSessionId!=='function')fail('INVALID_CAPABILITY_BRIDGE');
  let settings=normalizeHostCapabilitySettings(),fingerprint=JSON.stringify(settings),revision=null,closed=false;
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
    only(input,['limit','offset','verifySessionIds']);const limit=input.limit===undefined?25:number(input.limit,1,100),offset=input.offset===undefined?0:number(input.offset,0,100000);
    if(input.verifySessionIds!==undefined&&(!Array.isArray(input.verifySessionIds)||input.verifySessionIds.length>64))fail('INVALID_CAPABILITY_INPUT');
    const verifyIds=[...new Set((input.verifySessionIds??[]).map(identifier))].sort();
    if(!settings.sessionReadEnabled)fail('CAPABILITY_DISABLED');
    const rows=[...new Map((await visibleSessions(signal,expected)).filter(row=>scopeFor(false)==='all'||settings.allowedSessionIds.includes(row.sessionId)).map(row=>[row.sessionId,row])).values()].sort((a,b)=>a.sessionId<b.sessionId?-1:a.sessionId>b.sessionId?1:0);
    const items=[];let used=0;for(const row of rows.slice(offset,offset+limit)){const item={sessionId:row.sessionId,updatedAt:row.updatedAt,running:row.running===true,agentAvailable:row.agentAvailable===true,blank:row.blank===true,...(row.cwd?{cwd:boundedText(row.cwd,256)}:{})};used+=JSON.stringify(item).length;if(used>12000)break;items.push(item);}
    const hasMore=offset+items.length<rows.length;
    const visibleIds=new Set(rows.map(row=>row.sessionId));
    return {items,total:rows.length,hasMore,offset,nextOffset:hasMore?offset+items.length:null,verifiedVisibleSessionIds:verifyIds.filter(id=>visibleIds.has(id)),missingSessionIds:verifyIds.filter(id=>!visibleIds.has(id)),accessScope:settings.sessionReadScope,sessionMode:'external-resources',activatedAgent:false};
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
    return {sessionId,throughSeq,activeTurn:activeSessionTurn(inspection.events),messages,hasMore,nextBeforeSeq:hasMore&&Number.isSafeInteger(firstSeq)?firstSeq:null,truncated,activatedAgent:false,source:'external-dsh-session',untrustedContent:true};
  }
  async function sessionObserve(input,signal,expected){
    only(input,['sessionId','afterSeq','prefixDigest','limit']);const sessionId=identifier(input.sessionId),afterSeq=number(input.afterSeq,-1,Number.MAX_SAFE_INTEGER),limit=input.limit===undefined?10:number(input.limit,1,30);
    if(input.prefixDigest!==undefined&&(typeof input.prefixDigest!=='string'||!/^[a-f0-9]{64}$/iu.test(input.prefixDigest)))fail('INVALID_CAPABILITY_INPUT');
    const inspection=await inspectAllowed(sessionId,false,signal,expected),events=inspection.events,records=observationRecords(events),throughSeq=events.at(-1)?.seq??-1;
    if(!Number.isSafeInteger(throughSeq)||throughSeq< -1||records.some(row=>row.seq>throughSeq))fail('DSH_SESSION_READ_UNAVAILABLE');
    const reset=reason=>({sessionId,messages:[],afterSeq,throughSeq,nextAfterSeq:-1,hasMore:false,prefixDigest:observationDigest(sessionId,[], -1),resetRequired:true,resetReason:reason,historyTruncated:false,truncated:false,activatedAgent:false,source:'external-dsh-session',untrustedContent:true});
    if(afterSeq>throughSeq)return reset('cursor-beyond-current-log');
    if(afterSeq>=0&&input.prefixDigest===undefined)return reset('prefix-digest-required');
    if(input.prefixDigest!==undefined&&input.prefixDigest.toLowerCase()!==observationDigest(sessionId,records,afterSeq))return reset('visible-prefix-changed');
    const pending=records.filter(row=>row.seq>afterSeq),window=afterSeq===-1?pending.slice(-limit):pending.slice(0,limit),messages=[];let used=0;
    for(const row of window){
      const filtered=sensitiveObservation(row.text),full=filtered?'[敏感内容已过滤]':row.text,text=clipObservation(full,Math.min(4000,20000-used));if(!text)break;
      used+=text.length;messages.push({...row,text,...(filtered?{filtered:true}:{}),...(text.length<full.length?{truncated:true}:{})});
    }
    const historyTruncated=afterSeq===-1&&pending.length>window.length,last=messages.at(-1)?.seq??afterSeq,hasMore=records.some(row=>row.seq>last),nextAfterSeq=hasMore?last:throughSeq;
    // Inspect is a cold persisted-log read. Verify the exact captured prefix
    // once more after I/O, as well as the live grant/visibility, before release.
    const final=await inspectAllowed(sessionId,false,signal,expected),finalRecords=observationRecords(final.events),finalSeq=final.events.at(-1)?.seq??-1;
    if(finalSeq<throughSeq||observationDigest(sessionId,records,throughSeq)!==observationDigest(sessionId,finalRecords,throughSeq))return reset('visible-prefix-changed-during-read');
    await assertAllowed(sessionId,false);assertCurrent(signal,expected);
    return {sessionId,messages,afterSeq,throughSeq,nextAfterSeq,hasMore,prefixDigest:observationDigest(sessionId,records,nextAfterSeq),resetRequired:false,historyTruncated,truncated:messages.some(row=>row.truncated===true)||messages.length<window.length,activatedAgent:false,source:'external-dsh-session',untrustedContent:true};
  }
  async function sessionWrite(operation,input,context,signal,expected){
    only(input,operation==='dsh-session-prompt'?['sessionId','text']:['sessionId','expectedTurn','expectedTurnStartSeq']);const sessionId=identifier(input.sessionId);
    if(operation==='dsh-session-prompt'&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>12000))fail('INVALID_CAPABILITY_INPUT');
    if(operation==='dsh-session-cancel'){number(input.expectedTurn,1,Number.MAX_SAFE_INTEGER);number(input.expectedTurnStartSeq,0,Number.MAX_SAFE_INTEGER);}
    if(typeof context?.agent!=='string'||typeof context?.jobId!=='string'||!context.agent||!context.jobId)fail('INVALID_CAPABILITY_CONTEXT');
    await inspectAllowed(sessionId,true,signal,expected);assertCurrent(signal,expected);
    const requestId='bh-'+createHash('sha256').update(context.agent+'\n'+context.jobId+'\n'+(context.requestId??'')).digest('hex').slice(0,48);
    const service=controller(),receipt={operation,sessionId,requestId,at:Date.now()};let dispatched=false;
    try{
      assertCurrent(signal,expected);
      if(operation==='dsh-session-prompt'){
        dispatched=true;
        const result=await service.prompt({sessionId,requestId,mode:'queue',content:[{type:'text',text:input.text}]},signal);
        assertCurrent(signal,expected);if(result?.accepted!==true)throw unknown(undefined,receipt);
        return {accepted:true,status:'accepted-not-completed',receipt,metadata:{externalModel:true,accounting:'owned-by-external-session',createsSession:false},meaning:'目标会话已接收；不代表任务执行完成，模型工作由目标会话独立管理。'};
      }
      let agents;try{agents=ctx?.agents??ctx?.get?.('agents');}catch{}
      const targetAgent=agents?.get?.(sessionId);
      if(!targetAgent||typeof targetAgent.cancel!=='function'||targetAgent.session?.id!==sessionId||typeof targetAgent.session.snapshotEvents!=='function')fail('DSH_SESSION_CANCEL_UNAVAILABLE');
      const turn=activeSessionTurn(targetAgent.session.snapshotEvents());
      if(targetAgent.status!=='running'||!turn||turn.turn!==input.expectedTurn||turn.turnStartSeq!==input.expectedTurnStartSeq)fail('DSH_SESSION_TASK_CHANGED');
      if(!ordinaryHostSession(targetAgent.session.header??{id:sessionId})||agents.get(sessionId)!==targetAgent)fail('DSH_SESSION_NOT_VISIBLE');
      receipt.targetTurn=turn;
      // No await from the live identity check to Agent.cancel: the host cannot
      // switch turns between them. This is the same public Agent API used by
      // SessionController.cancel, with its keepInbox behavior retained.
      assertCurrent(signal,expected);dispatched=true;targetAgent.cancel({kind:'user'},{keepInbox:true});
      // Observe this exact turn's end, even if another task has since started.
      const until=Date.now()+4000;
      while(true){
        const inspection=await service.inspect(sessionId,signal);assertCurrent(signal,expected);
        const end=inspection?.events?.find(event=>event.type==='turn/end'&&event.seq>turn.turnStartSeq&&event.data?.turn===turn.turn);
        if(end)return {accepted:true,status:'cancellation-requested-and-observed-turn-end',receipt,observedAt:Date.now(),observedTurnEndSeq:end.seq,endReason:end.data.reason?.kind??'unknown',pendingInboxRetained:true,taskCompleted:false,metadata:{externalModel:true},meaning:'已请求取消并观察到指定轮次结束；不表示原任务成功，也不表示后续队列已停止。'};
        if(Date.now()>=until)throw unknown(undefined,receipt);
        await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??error('CAPABILITY_CANCELLED'));},timer=setTimeout(done,200);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
      }
    }catch(cause){if(dispatched&&cause?.code!=='CAPABILITY_OUTCOME_UNKNOWN')throw unknown(cause,receipt);throw cause;}
  }
  return {
    configure(input,{revision:nextRevision}={}){
      if(closed)fail('CAPABILITY_BRIDGE_CLOSED');const next=normalizeHostCapabilitySettings(input),nextFingerprint=JSON.stringify(next);
      if(nextFingerprint!==fingerprint||(nextRevision!==undefined&&nextRevision!==revision)){for(const aborter of active)aborter.abort(error('CAPABILITY_POLICY_CHANGED'));settings=next;fingerprint=nextFingerprint;revision=nextRevision??revision;}
      return this.status();
    },
    status(){let available=false;try{available=!!controller();}catch{}return {backend:'host-bridge',closed,session:{available,readEnabled:settings.sessionReadEnabled,readScope:settings.sessionReadScope,writeEnabled:settings.sessionWriteEnabled,writeScope:settings.sessionWriteScope,allowedSessionIds:[...settings.allowedSessionIds],coldReads:true,externalModelOnPrompt:true,dynamicHostVisibility:true,excludesHumanSession:true,excludesSubagents:true,cancelIdentity:'turn-and-start-seq'}};},
    async handle({operation,input,context}={},signal=new AbortController().signal){
      if(closed)fail('CAPABILITY_BRIDGE_CLOSED');const scoped=scopeSignal(signal),expected=fingerprint;
      try{assertCurrent(scoped.signal,expected);
        if(operation==='dsh-session-list')return await sessionList(input,scoped.signal,expected);
        if(operation==='dsh-session-read')return await sessionRead(input,scoped.signal,expected);
        if(operation==='dsh-session-observe')return await sessionObserve(input,scoped.signal,expected);
        if(['dsh-session-prompt','dsh-session-cancel'].includes(operation))return await sessionWrite(operation,input,context,scoped.signal,expected);
        fail('CAPABILITY_NOT_FOUND');
      }finally{scoped.release();}
    },
    async close(){if(closed)return;closed=true;for(const aborter of active)aborter.abort(error('CAPABILITY_BRIDGE_CLOSED'));active.clear();},
  };
}
