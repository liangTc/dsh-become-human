import {parentCapabilityRequest} from './capability-parent.mjs';
import {checkpointForOpportunity} from './behavior-selection.mjs';
import {structured} from './learning.mjs';
import {transientModelFailure} from './model-failure.mjs';
import {workObservationPolicy} from './work-observation.mjs';
import {sessionScopeAvailable} from './session-grants.mjs';

const observeId='observe-work-sessions',assistId='offer-work-assistance';
const observeQuestion='检查已授权工作会话是否有值得保留的新进展。';
const emptyInput={type:'object',properties:{},additionalProperties:false};
const transientReads=new Set(['DSH_SESSION_READ_UNAVAILABLE','DSH_SESSION_CONTROLLER_UNAVAILABLE','HUMAN_SESSION_UNAVAILABLE','CAPABILITY_BRIDGE_UNAVAILABLE','CAPABILITY_BRIDGE_DISCONNECTED','CAPABILITY_BRIDGE_CLOSED','CAPABILITY_BRIDGE_TIMEOUT','CAPABILITY_BRIDGE_REQUEST_LIMIT']);
const invisible=new Set(['DSH_SESSION_NOT_FOUND','DSH_SESSION_NOT_VISIBLE','CAPABILITY_SCOPE_DENIED']);
const codeOf=error=>/^[A-Z_]{3,80}$/u.test(error?.code??error?.message)?error.code??error.message:'WORK_OBSERVATION_FAILED';
const available=agent=>agent.factory.workObservation.settings(agent.id).enabled&&sessionScopeAvailable(agent.factory.tools.configuration(agent.id).bridge,false,agent.id);

function modelInput(batch){
  const messages=[{role:'system',content:[{type:'text',text:workObservationPolicy}]},{role:'user',content:[{type:'text',text:JSON.stringify(batch.model)}]}];
  const inputBytes=Buffer.byteLength(JSON.stringify(messages))+256;
  Object.defineProperty(messages,'contextReport',{value:{version:2,lane:'executor',kind:'work-observation',budget:null,localInputLimit:false,required:inputBytes,estimatedInput:inputBytes,estimate:'utf8-bytes-plus-framing',counts:{workUnits:batch.model.units.length},workBatchId:batch.id}});
  return messages;
}

// No second turn, scheduler, quota pool or model route. The selected behavior
// receives all of these from the parent's ordinary execution context.
async function observeWork(agent,ctx,readHost){
  const {workObservation:store,journal,tools}=agent.factory,id=agent.id,settings=store.settings(id),bridge=tools.configuration(id);
  function valid(){
    ctx.signal.throwIfAborted();ctx.valid();
    if(!available(agent)||bridge.revision!==tools.configuration(id).revision||settings.revision!==store.settings(id).revision)throw Error('CAPABILITY_POLICY_CHANGED');
  }
  const read=async(operation,input)=>{
    valid();
    const result=await readHost(operation,input,{signal:ctx.signal,context:{agent:id,policy:bridge.bridge,policyRevision:bridge.revision,observation:true}});
    valid();return result;
  };
  const nextTime=()=>store.now(id)+settings.intervalMs;
  const status=store.status(id);
  if(status.held)return {status:'failed',summary:'本次工作观察需要明确重试。',error:'WORK_OBSERVATION_RETRY_REQUIRED'};
  if(!journal.value(id,'workObservationRequested',false)&&status.nextCheckAt>store.now(id))return {status:'completed',summary:'尚未到工作观察时间。'};
  journal.put(id,'workObservationRequested',false);
  store.noteStatus(id,{phase:'reading'});
  let sessions=0,remembered=0,deferred=0,modelCalled=false;
  try{
    const verifyOffset=journal.value(id,'workObservationVerifyOffset',0),tracked=store.trackedSessions(id,verifyOffset,65);
    const offset=journal.value(id,'workObservationScanOffset',0);
    const listing=await read('dsh-session-list',{limit:settings.maxSessionsPerCheck,offset,verifySessionIds:tracked.slice(0,64)});
    if(!Array.isArray(listing?.items)||listing.items.length>settings.maxSessionsPerCheck)throw Error('INVALID_WORK_OBSERVATION_LIST');
    for(const session of listing.missingSessionIds??[])store.invalidateSession(id,session,'DSH_SESSION_NOT_VISIBLE');
    store.markVisible(id,listing.verifiedVisibleSessionIds??[]);
    journal.put(id,'workObservationVerifyOffset',tracked.length>64?verifyOffset+64:0);
    for(const row of listing.items){
      valid();
      const session=row.sessionId;
      if(!store.allowed(id,session))continue;
      if(store.sessionBlocked(id,session)){deferred++;continue;}
      let batch,response;
      try{
        const cursor=store.cursor(id,session);
        const observe=(afterSeq,prefixDigest,limit=settings.maxMessagesPerSession)=>read('dsh-session-observe',{sessionId:session,afterSeq,...(prefixDigest?{prefixDigest}:{}),limit});
        let page=await observe(cursor.afterSeq,cursor.prefixDigest);
        if(page.resetRequired){store.invalidateSession(id,session,'SOURCE_CONTENT_CHANGED');page=await observe(-1,null);}
        if(page.sessionId!==session||page.resetRequired)throw Error('INVALID_WORK_OBSERVATION_PAGE');
        sessions++;store.markVisible(id,[session]);
        if(!page.messages?.length&&page.nextAfterSeq===cursor.afterSeq&&page.prefixDigest===cursor.prefixDigest){store.clearFault(id,session);continue;}
        batch=store.stage(id,page);
        if(batch.status!=='pending')continue;
        let output={items:[]};
        if(batch.model.units.length){
          store.noteStatus(id,{phase:'extracting'});store.audit(id,'started',{batchId:batch.id,taskId:ctx.task.id,sessionId:session,units:batch.model.units.length});
          modelCalled=true;response=await ctx.request(modelInput(batch));valid();
          const checked=await observe(page.nextAfterSeq,page.prefixDigest,1);
          if(checked.sessionId!==session)throw Error('INVALID_WORK_OBSERVATION_PAGE');
          if(checked.resetRequired){store.invalidateSession(id,session,'SOURCE_CONTENT_CHANGED');continue;}
          output=structured(response.text);
        }
        const result=store.commit(id,batch.id,output);remembered+=result.items.length;
        if(response)store.audit(id,'model-completed',{batchId:batch.id,taskId:ctx.task.id,records:result.items.length,sessionId:session,attemptId:response.rid});
      }catch(error){
        valid();
        const code=codeOf(error);
        if(invisible.has(code)){store.invalidateSession(id,session,code);continue;}
        if(code==='AUTONOMOUS_BUDGET_EXHAUSTED'||code==='MODEL_BUDGET_ESTIMATE_UNAVAILABLE')throw error;
        if(response&&['INVALID_WORK_OBSERVATION_OUTPUT','INVALID_TASK_OUTPUT'].includes(code))journal.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:code,textChars:response.text.length});
        if(!store.sessionBlocked(id,session)){
          if(transientReads.has(code)||transientModelFailure(error.modelFailure))store.recordFault(id,session,code,true);
          else if(batch?.status==='pending')store.fail(id,batch.id,code);
          else store.recordFault(id,session,code,false);
        }
        deferred++;
        // A model-route failure can affect every session. Preserve its usage
        // and let the behavior framework finish the failed call exactly once.
        if(error.modelFailure)throw error;
      }
    }
    journal.put(id,'workObservationScanOffset',listing.hasMore?(listing.nextOffset??offset+listing.items.length):0);
    store.noteStatus(id,{phase:'waiting',lastCheckedAt:store.now(id),nextCheckAt:nextTime(),lastError:null,readSessions:sessions,remembered});
    store.audit(id,'checked',{sessions,remembered,deferred,hasMore:listing.hasMore===true,modelCalled});
    return {status:'completed',summary:`已读取 ${sessions} 个工作会话，保存 ${remembered} 条带来源的线索。${deferred?'另有 '+deferred+' 个会话暂缓。':''}`};
  }catch(error){
    const code=codeOf(error);
    if(ctx.signal.aborted){store.noteStatus(id,{phase:'suspended',nextCheckAt:store.now(id)});throw error;}
    if(code==='AUTONOMOUS_BUDGET_EXHAUSTED'){
      store.noteStatus(id,{phase:'waiting-budget',nextCheckAt:store.now(id),lastError:code});throw error;
    }
    if(code==='MODEL_BUDGET_ESTIMATE_UNAVAILABLE'){
      store.noteStatus(id,{phase:'failed',nextCheckAt:nextTime(),lastError:code});
      store.audit(id,'failed',{taskId:ctx.task.id,code,manualRetryRequired:false});throw error;
    }
    store.noteStatus(id,{phase:'waiting',lastError:code,nextCheckAt:nextTime()});
    store.audit(id,'failed',{code,manualRetryRequired:false});
    if(transientReads.has(code))return {status:'failed',error:code,summary:'宿主暂时无法提供会话目录，本次检查已结束。'};
    throw error;
  }
}

export function registerWorkObservationBehaviors(factory,{readHost=parentCapabilityRequest}={}){
  factory.behaviors.register(observeId,{version:1,title:'观察授权工作会话',description:'检查授权范围中的增量消息，选取值得保留的原文及其出处。',inputSchema:emptyInput,available,
    opportunities(agent,{now}){
      const state=factory.workObservation.status(agent.id);
      return !state.held&&(factory.journal.value(agent.id,'workObservationRequested',false)||now>=(state.nextCheckAt??0))?[{question:observeQuestion,input:{}}]:[];
    },execute:(agent,_input,ctx)=>observeWork(agent,ctx,readHost)});
  factory.behaviors.register(assistId,{version:1,title:'提出工作协助事项',description:'判断一条仍有效的用户工作线索是否值得列为待确认事项，主人仍决定是否推进。',available,
    inputSchema:{type:'object',properties:{recordId:{type:'string',maxLength:80}},required:['recordId'],additionalProperties:false},
    opportunities(agent){
      const item=factory.workObservation.assistanceCandidate(agent.id);
      return item?[{question:item.category==='blocker'?'是否值得就最近一条有来源的工作阻塞，建立待确认的协助事项？':'是否值得就最近一条有来源的工作待办，建立待确认的协助事项？',input:{recordId:item.id}}]:[];
    },
    execute(agent,{recordId},ctx){
      ctx.valid();const item=factory.workObservation.get(agent.id,recordId);
      if(!item.valid||item.role!=='user'||!['todo','blocker'].includes(item.category))return {status:'failed',summary:'这条线索已失效或不适合建立协助事项。',error:'WORK_OBSERVATION_RECORD_NOT_AVAILABLE'};
      factory.cognition.createMatter(agent.id,{requestId:'work-observation:'+item.id,title:item.category==='blocker'?'工作会话中有一条待确认的阻塞':'工作会话中有一条待确认的待办',kind:'conversation',why:'只读工作观察保留了带来源的线索，是否需要协助仍待主人确认。',expectedOutcome:'在合适时机确认是否需要帮助，再由主人决定具体任务。',stopCondition:'来源失效、记忆撤回、主人不需要，或已经完成本次确认时停止。',nextAction:'结合仍有效的工作记忆，选择是否自然询问主人需要怎样的协助。',priority:30,links:[{type:'work-memory',id:item.id}],tags:['工作观察']},{actor:'agent'});
      return {status:'completed',summary:'已建立一条待确认的工作协助事项。'};
    }});
}

// An explicit button press queues the exact authorized behavior even when the
// next autonomous opportunity selection would prefer a different activity.
export function queueWorkObservation(agent){
  const f=agent.factory,id=agent.id,store=f.workObservation;
  if(!available(agent))throw Error('WORK_OBSERVATION_NOT_AUTHORIZED');
  if(store.status(id).held)throw Error('WORK_OBSERVATION_RETRY_REQUIRED');
  return f.journal.transaction(()=>{
    const prior=f.journal.value(id,'workObservationQueuedTask',null),task=prior&&f.autonomy.getTask(prior);
    if(task&&['ready','suspended','waiting-budget','executing'].includes(task.status)&&task.persona_version===f.autonomy.persona(id,'selection').version){
      f.journal.put(id,'workObservationRequested',true);return task.id;
    }
    const definition=f.behaviors.definition(agent,observeId);
    const cp=checkpointForOpportunity({kind:'behavior',behaviorId:observeId,behaviorFingerprint:definition.fingerprint,behaviorDefinition:definition,behaviorInput:{},question:observeQuestion});
    f.autonomy.clearDeferral(id,cp);
    const next=f.autonomy.task(id,'behavior',{...cp,eventIds:[],plan:{decision:'execute',question:observeQuestion,value:'主人安排了一次工作观察。',input:{}}},f.autonomy.persona(id,'selection').version);
    f.journal.put(id,'workObservationQueuedTask',next.id);f.journal.put(id,'workObservationRequested',true);
    store.noteStatus(id,{phase:'queued',lastError:null,nextCheckAt:store.now(id)});return next.id;
  });
}

// Earlier workers stored only a global hold and a boolean manual request.
// Narrow a legacy hold only when its last failure names the exact failed batch.
export function restoreWorkObservation(agent){
  const {workObservation:store,journal}=agent.factory,id=agent.id;
  // The signed grant can survive a crash just before invalidation commits.
  store.reconcilePolicy(id);
  const state=store.status(id);
  if(state.phase==='waiting-budget'&&state.lastError==='MODEL_BUDGET_ESTIMATE_UNAVAILABLE'){
    store.noteStatus(id,{phase:'failed',nextCheckAt:store.now(id)+store.settings(id).intervalMs});
  }
  if(store.status(id).held){
    const row=journal.db.prepare("SELECT CASE WHEN json_valid(data) THEN data END AS data FROM audit WHERE agent=? AND kind='work-observation-failed' ORDER BY seq DESC LIMIT 1").get(id);
    const evidence=row?.data&&JSON.parse(row.data);
    const failed=typeof evidence?.batchId==='string'&&journal.db.prepare("SELECT session FROM human_work_observation_batch WHERE agent=? AND id=? AND status='failed'").get(id,evidence.batchId);
    if(failed&&evidence.code===store.status(id).lastError)journal.transaction(()=>{
      store.recordFault(id,failed.session,evidence.code,false);
      store.noteStatus(id,{phase:'waiting',held:false,lastError:null,nextCheckAt:store.now(id)});
    });
  }
  if(journal.value(id,'workObservationRequested',false)&&available(agent)&&!store.status(id).held)queueWorkObservation(agent);
}
