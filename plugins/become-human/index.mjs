import {initializeDevelopment} from './development-runtime.mjs';
import {boardOperations,controlBoard,prepareMatterRetry} from './cognition-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import {conversationPolicy,conversationalText,wantsSources} from './conversation.mjs';
import {getDshRuntimeVersion} from '@deepseek-ai/dsh-app-boot';
import {HumanFactory} from './driver.mjs';
import {DeletionLab} from './deletion.mjs';
import {SessionRetirement} from './retirement.mjs';
import {expressionSkills,expressionStatus} from './expression.mjs';
import {supersedeOwnerBatch} from './owner-turns.mjs';
import {replyPresentation} from './presentation.mjs';
export const name='become-human';
export const inject=['agents','sessions','sessionPersistence','sessionProjections','llm','connection','webServer','workspaceRegistry'];
export const Config=z.object({intervalMs:z.number().default(15000),tokenBudget:z.number().default(12000),localQuotaEnabled:z.boolean().default(true),maxCycles:z.number().default(3),maxTokens:z.number().default(512),requestTimeoutMs:z.number().default(45000),interactiveOnly:z.boolean().default(false),provider:z.string(),model:z.string(),reasoningEffort:z.string(),budgetRound:z.string(),allowedRoutes:z.array(z.object({provider:z.string(),model:z.string()})).default([]),modelCapabilities:z.array(z.object({provider:z.string(),model:z.string(),adapter:z.union(['pi-ai','deepseek-native']),reasoningEfforts:z.array(z.union(['off','low','medium','high','max']))})).default([]),domainEnabled:z.boolean().default(true),sharedBudgetGuard:z.boolean().default(true)});
export async function apply(ctx,config){
  let expressionRegistryRegistered=false;
  ctx.inject(['skills'],scoped=>{
    for(const skill of expressionSkills())scoped.skills.register(skill);
    expressionRegistryRegistered=true;
    scoped.effect(()=>()=>{expressionRegistryRegistered=false;});
  });
  const runtimeVersion=getDshRuntimeVersion();
  if(runtimeVersion!=='0.2.0-rc.2')throw new Error('Unsupported DSH runtime version');
  const storage=ctx.sessionPersistence;if(typeof storage.guard!=='function')throw new Error('P0_REQUIRES_GUARDED_STORAGE');await storage.ready;
  if(!Number.isInteger(config.intervalMs)||config.intervalMs<5000||config.intervalMs>3600000)throw new Error('Invalid interval');
  if(!Number.isInteger(config.maxCycles)||config.maxCycles<0||config.maxCycles>2880||!Number.isInteger(config.maxTokens)||config.maxTokens<64||config.maxTokens>4096||!Number.isInteger(config.tokenBudget)||config.tokenBudget<1024||config.tokenBudget>20000000||!Number.isInteger(config.requestTimeoutMs)||config.requestTimeoutMs<1000||config.requestTimeoutMs>120000)throw new Error('Invalid limits');
  const root=path.join(process.env.DSH_HOME,'become-human');await fs.mkdir(root,{recursive:true});
  ctx.plugin(HumanFactory,{...config,journal:path.join(root,'control.sqlite')});
  await ctx.inject(['becomeHuman'],async scoped=>{
    const factory=scoped.becomeHuman,journal=factory.journal;
    scoped.inject(['skills'],s=>{factory.management.skills.registry=s.skills;if(factory.controllerSessionId)factory.management.skills.refreshRegistry(factory.controllerSessionId);});
    journal.safety=storage.ledger;
    const deletionLab=await new DeletionLab(path.join(root,'deletion-lab'),journal).init();
    scoped.effect(()=>()=>deletionLab.close());let deletionPreview=null;
    const idFile=path.join(root,'agent.json');let id;
    try{id=JSON.parse(await fs.readFile(idFile,'utf8')).sessionId;}catch(e){if(e.code!=='ENOENT')throw e;id=crypto.randomUUID();}
    const retirement=new SessionRetirement(storage,journal,factory.domain,{dataRoot:root,quiesce:async old=>{if(agent?.id===old){agent.cancel({kind:'disposed'},{keepInbox:true});await handle.dispose();}},replace:async(old,next)=>{if(id===old&&agent){id=next;factory.controllerSessionId=id;handle=await scoped.agents.create({sessionId:id,meta:{cwd:process.cwd()}});agent=handle.agent;initializeDevelopment(factory,id);await factory.customMcpCapabilities.sync(id);factory.config.intervalMs=factory.autonomy.settings(id).wakeIntervalMs;factory.management.skills.refreshRegistry(id);journal.put(id,'nativeTracingSince',Date.now());await fs.writeFile(idFile,JSON.stringify({sessionId:id}));await workspace.attachSession(id);}}});
    let handle,agent;
    await storage.ledger.configureBudget(config.budgetRound??'legacy',config.tokenBudget,journal.get(id)?.used??0);
    await storage.ledger.configureLocalQuota(config.localQuotaEnabled!==false);
    await retirement.recover();
    for(const row of storage.ledger.rows.filter(r=>r.kind==='retire')){const data=JSON.parse(row.data);if(id===data.oldId)id=data.newId;}
    factory.controllerSessionId=id;
    factory.management.reconcileProfile(id);
    await factory.customMcpCapabilities.sync(id);
    scoped.provide('humanCapabilities',Object.freeze({contractVersion:1,register:(name,descriptor)=>factory.tools.register(name,descriptor),catalog:()=>factory.tools.catalog(id)}));
    if(factory.tools.configuration(id).mcp.bundledEnabled)try{await factory.mcpCapabilities.start(AbortSignal.timeout(5000));}catch(error){journal.audit(id,'capability-provider-unavailable',{provider:'bundled-public-mcp',code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'MCP_STARTUP_FAILED'});}
    const stored=await scoped.sessionPersistence.stat(id);
    handle=stored?await scoped.agents.resume({resumeSessionId:id}):await scoped.agents.create({sessionId:id,meta:{cwd:process.cwd()}});
    agent=handle.agent;factory.config.intervalMs=factory.autonomy.settings(id).wakeIntervalMs;factory.management.skills.refreshRegistry(id);if(!journal.value(id,'nativeTracingSince',null))journal.put(id,'nativeTracingSince',Date.now());await fs.writeFile(idFile,JSON.stringify({sessionId:id}));
    journal.db.prepare('UPDATE control SET used=? WHERE id=?').run(storage.ledger.used(),id);journal.put(id,'budgetBase',storage.ledger.budget.base);journal.put(id,'budgetRound',storage.ledger.budget.round);
    const workspace=await scoped.workspaceRegistry.create(process.cwd());await workspace.attachSession(id);
    for(const event of agent.session.snapshotEvents())if(event.type==='user/message')factory.domain.observe(id,event.data,event.time);
    factory.domain.repairPreferenceSlots(id);
    initializeDevelopment(factory,id);
    factory.tools.recover(id);
    const bootId=crypto.randomUUID();
    const messageExists=messageId=>agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===messageId||e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.id===messageId));
    async function deliverRequest(row){
      if(!messageExists(row.message_id))agent.send({id:row.message_id,role:'user',source:{kind:'human'},content:[{type:'text',text:row.text}]},journal.value(id,'target:'+row.request_id,'next-turn'),false);
      await agent.flush();journal.reconcile(agent.session);
      const message=agent.session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id===row.message_id)?.data??[...agent.inbox.nextStep,...agent.inbox.nextTurn].find(m=>m.id===row.message_id);if(message&&!agent.active){factory.domain.observe(id,message);}
      journal.db.prepare("UPDATE user_request SET status='committed' WHERE agent=? AND request_id=?").run(id,row.request_id);
    }
    for(const pending of journal.db.prepare("SELECT * FROM user_request WHERE agent=? AND status='pending'").all(id))await deliverRequest(pending);
    function retryCandidates(){
      const completed=new Set();let candidates=[];
      for(const r of journal.db.prepare('SELECT state,request FROM attempt WHERE agent=? ORDER BY started DESC').all(id)){
        const ids=JSON.parse(r.request).admittedIds??[];
        if(['completed','wait'].includes(r.state))for(const mid of ids)completed.add(mid);
        else if(['failed','cancelled','output-limit','interrupted'].includes(r.state)&&!candidates.length)candidates=ids.filter(mid=>!completed.has(mid)&&factory.domain.sourceUsable(id,mid));
      }
      return candidates.map(mid=>agent.session.snapshotEvents().find(e=>e.type==='user/message'&&e.data.id===mid)?.data).filter(Boolean);
    }
    function retryCandidate(){return retryCandidates()[0];}
    let lastSafeState,retirementPreview=null;
    function state(){
      if(storage.ledger.retired(id))return {...lastSafeState,revision:journal.db.prepare('SELECT total_changes() AS n').get().n+storage.ledger.rows.length,retiring:true,management:null,desired:'paused',status:'maintenance',agentBusy:true,canThink:false,messages:[],reminders:[],attempts:[],audit:[],persona:'',memory:'',memories:[],personaState:null,inbox:0,retirement:{operations:retirement.status(),preview:null},safety:storage.ledger.status()};
      const control=journal.get(id),rows=journal.db.prepare('SELECT * FROM outbox WHERE agent=? ORDER BY seq DESC LIMIT 30').all(id).reverse().map(row=>{const request=row.event_key?.startsWith('user:')?journal.db.prepare('SELECT request_id FROM user_request WHERE agent=? AND message_id=?').get(id,row.event_key.slice(5)):null;return {...row,origin:request?journal.value(id,'origin:'+request.request_id,'web'):row.kind==='status'?'system':'agent'};});
      for(const row of rows)if(row.kind==='assistant'){const owner=journal.db.prepare("SELECT text FROM outbox WHERE agent=? AND kind='user' AND seq<? ORDER BY seq DESC LIMIT 1").get(id,row.seq);row.displayText=conversationalText(row.text,{includeSources:wantsSources(owner?.text??'')});const event=agent.session.snapshotEvents().find(e=>e.type==='assistant/message'&&e.data.message.id===row.event_key?.slice(10));row.bubbleParts=replyPresentation(journal,id,event,row.displayText).parts;}
      const budgetRemaining=storage.ledger.budget.allowance-(storage.ledger.used()-storage.ledger.budget.base);
      const attempts=journal.db.prepare('SELECT id,turn,state,trigger,config,usage,usage_confidence,error,text_chars,reasoning_chars,failure_facts,started,ended FROM attempt WHERE agent=? ORDER BY started DESC LIMIT 8').all(id);
      const autonomy=factory.autonomy.snapshot(id),autonomyEnabled=autonomy.settings.enabled;
      return lastSafeState={plugin:'dsh-become-human',version:'0.7.0-beta.5',expression:expressionStatus(expressionRegistryRegistered),ownerInputRevision:journal.db.prepare('SELECT COALESCE(max(rowid),0) AS n FROM user_request WHERE agent=?').get(id).n,management:factory.management.snapshot(id),bootId,revision:journal.db.prepare('SELECT total_changes() AS n').get().n+storage.ledger.rows.length,runtime:runtimeVersion,sessionId:id,provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort??'provider-default',retryableInput:!!retryCandidate(),agentBusy:!!agent.active,activeLane:agent.activeLane??null,canThink:autonomyEnabled||config.interactiveOnly||config.localQuotaEnabled===false||budgetRemaining>=1024+config.maxTokens,localQuotaEnabled:config.localQuotaEnabled!==false,desired:control.desired,cancelEpoch:control.epoch,pauseRevision:journal.value(id,'pauseRevision',0),status:agent.status,used:storage.ledger.used()-storage.ledger.budget.base,cumulativeUsed:storage.ledger.used(),budgetRound:journal.value(id,'budgetRound','legacy'),budget:config.localQuotaEnabled===false?null:config.tokenBudget,remaining:journal.value(id,'remaining',0),cycleLimit:journal.value(id,'driveMode','bounded')==='continuous'?null:autonomyEnabled?1:config.maxCycles===0?null:config.maxCycles,driveMode:journal.value(id,'driveMode','bounded'),nextTickAt:control.next_tick,longRun:journal.longRunStats(id),successes:journal.value(id,'successes',0),intervalMs:factory.config.intervalMs,interactiveOnly:autonomyEnabled?false:config.interactiveOnly,requestTimeoutMs:config.requestTimeoutMs,inbox:agent.inbox.nextStep.length+agent.inbox.nextTurn.length,lastUsage:journal.value(id,'lastUsage',null),lastUsageConfidence:journal.value(id,'lastUsageConfidence','legacy-unverified'),lastError:journal.value(id,'lastError',null),stopReason:journal.value(id,'stopReason',null),persona:factory.domain.persona(id).core,memory:journal.value(id,'memory','尚无简记。'),receipt:journal.value(id,'receipt',0),messages:rows,attempts,responseRecovery:{pending:journal.staged(id).length,committed:journal.db.prepare("SELECT count(*) AS n FROM response_stage WHERE agent=? AND state='committed'").get(id).n},deletion:{...deletionLab.status(),preview:deletionPreview?.expires>Date.now()?deletionPreview:null},safety:storage.ledger.status(),retirement:{operations:retirement.status(),preview:retirementPreview?.expires>Date.now()?retirementPreview:null},memories:factory.domain.list(id,{limit:20}),personaState:factory.domain.persona(id),goals:factory.domain.context(id).goals,reminders:factory.reminders.list(id),autonomy,modelGate:{inflight:factory.inflight,unbudgetedCalls:'denied',tools:autonomyEnabled?'public-research-and-exact-approved-report':'disabled',nativeUpload:'disabled',fork:'disabled',embedding:'disabled'},audit:journal.db.prepare('SELECT seq,kind,data FROM audit WHERE agent=? ORDER BY seq DESC LIMIT 12').all(id)};
    }
    let operations=Promise.resolve();
    const mutate=input=>operations=operations.catch(()=>{}).then(async()=>{
      let actionResult,mcpDiscovery;
      if(!input||typeof input!=='object')throw new Error('INVALID_REQUEST');
      if(input.op!=='pause'&&input.sessionId!==undefined&&input.sessionId!==id)throw new Error('STALE_SESSION');
      if(boardOperations.has(input.op)){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');storage.guard(id);actionResult=controlBoard(agent,input);
      }else if(input.op==='capability-mcp-discover'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        mcpDiscovery=await factory.customMcpCapabilities.discover(id,{server:input.server,expectedRevision:input.expectedRevision});
      }else if(input.op==='capability-configure'){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        await factory.tools.configure(id,input.settings,input.expectedRevision);
        await factory.customMcpCapabilities.sync(id);
      }else if(['tool-submit','tool-cancel','tool-approve'].includes(input.op)){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');
        if(input.op==='tool-submit')factory.tools.submit(id,input);else if(input.op==='tool-approve')await factory.tools.approve(id,input.jobId,input);else factory.tools.cancel(id,input.jobId,input.expectedVersion);
        if(agent.desired().desired==='running'){agent.wake=true;agent.pump();}
      }else if(['action-propose-report','action-approve','action-cancel'].includes(input.op)){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');
        if(input.op==='action-propose-report'){if(input.goal!==undefined)throw new Error('INVALID_ACTION_GOAL');actionResult=factory.actions.proposeReport(id,{requestId:input.requestId,title:input.title,noteIds:input.noteIds});}
        else if(input.op==='action-approve'){actionResult=factory.actions.approve(id,input.actionId,{expectedVersion:input.expectedVersion,digest:input.digest});await journal.safety.anchor();}
        else {actionResult=factory.actions.cancel(id,input.actionId,{expectedVersion:input.expectedVersion});await journal.safety.anchor();journal.put(id,'action-loop-error:'+input.actionId,null);if(journal.value(id,'actionLoopError',null)?.actionId===input.actionId)journal.put(id,'actionLoopError',null);}
        factory.goals.reconcile(id);if(agent.desired().desired==='running'){agent.wake=true;agent.pump();}
      }else if(factory.management.handles(input.op)){if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');await factory.management.mutate(id,input);
      }else if(['schedule-create','schedule-update','schedule-toggle','schedule-cancel'].includes(input.op)){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');if(agent.active)throw new Error('AGENT_BUSY');
        if(input.op==='schedule-create'||input.op==='schedule-update')factory.reminders.save(id,input);else if(input.op==='schedule-toggle')factory.reminders.toggle(id,input);else {const row=factory.reminders.list(id).find(r=>r.id===input.id);if(!row||row.version!==input.expectedVersion)throw new Error('STALE_SCHEDULE');factory.reminders.cancel(id,input.id);}agent.armReminder();
      }else if(['reminder-create','reminder-cancel'].includes(input.op)){
        if(input.sessionId!==id)throw new Error('STALE_SESSION');
        if(agent.active)throw new Error('AGENT_BUSY');
        if(input.op==='reminder-create')factory.reminders.create(id,{requestId:input.requestId,dueAt:input.dueAt,text:input.text});
        else factory.reminders.cancel(id,input.reminderId);
        agent.armReminder();
      }else if(input.op==='autonomy-configure'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        if(input.settings?.enabled&&config.sharedBudgetGuard!==true)throw new Error('SIGNED_CONTROL_REQUIRED');
        if(input.expectedRevision!==undefined)factory.management.check(id,input.expectedRevision);await factory.autonomy.configure(id,input.settings);factory.config.intervalMs=factory.autonomy.settings(id).wakeIntervalMs;factory.management.bump(id,'autonomy-configured');journal.put(id,'autonomyActivatedAt',Date.now());
      }else if(input.op==='autonomy-retry-task'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        if(typeof input.taskId!=='string'||input.taskId.length>64)throw new Error('INVALID_TASK_RETRY');
        const task=factory.autonomy.getTask(input.taskId);
        if(!factory.autonomy.settings(id).enabled||!task||task.agent!==id||task.status!=='failed')throw new Error('INVALID_TASK_RETRY');
        if(task.checkpoint?.goal?.id||factory.goals.linked(id,task.id))throw new Error('GOAL_TASK_RETRY_REQUIRED');
        const checkpoint={...prepareMatterRetry(agent,task),roundId:crypto.randomUUID()};delete checkpoint.plan;delete checkpoint.reason;delete checkpoint.error;delete checkpoint.failureDiagnostic;delete checkpoint.searchFailure;
        factory.autonomy.clearDeferral(id,task.checkpoint);
        if(task.kind==='research'){delete checkpoint.discovery;delete checkpoint.researchReads;checkpoint.source=null;}
        factory.autonomy.clearDeferral(id,checkpoint);
        factory.autonomy.update(task.id,'ready',checkpoint);journal.put(id,'autonomyPaused',false);journal.put(id,'autonomyError',null);journal.put(id,'autonomyPhase','waiting');journal.put(id,'autonomyWait',null);
        factory.autonomy.event(id,'owner-retry:'+task.id+':'+Date.now(),'owner-retry',{taskId:task.id});
      }else if(['autonomy-pause','autonomy-resume'].includes(input.op)){
        journal.put(id,'autonomyPaused',input.op==='autonomy-pause');
        if(input.op==='autonomy-resume')journal.put(id,'autonomyError',null);
        if(input.op==='autonomy-pause'&&agent.active&&agent.activeLane!=='foreground'){journal.set(id,agent.desired().desired);journal.put(id,'autonomyPhase','preempting');agent.cancelController?.abort({kind:'user'});}
      }else if(input.op==='autonomy-grant'){
        await factory.autonomy.grant(id,input);
      }else if(input.op==='autonomy-grant-revoke'){
        await factory.autonomy.revoke(id,input.grantId);
        if(agent.active&&agent.activeLane!=='foreground'){journal.set(id,agent.desired().desired);journal.put(id,'autonomyPhase','preempting');agent.cancelController?.abort({kind:'user'});}
      }else if(input.op==='learning-feedback'||input.op==='learning-note-delete'){
        if(agent.active)throw new Error('PAUSE_REQUIRED');
        if(input.op==='learning-feedback')factory.autonomy.feedback(id,input.noteId,input.value,input.comment??'');else factory.autonomy.deleteNote(id,input.noteId);
      }else if(input.op==='session-delete-preview'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');retirementPreview=await retirement.preview(id);
      }else if(input.op==='session-delete-confirm'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        if(input.id!==id&&!storage.ledger.retired(input.id))throw new Error('INVALID_REQUEST');await retirement.request(input);retirementPreview=null;
      }else if(input.op==='session-delete-recover'){await retirement.recover();}
      else if(input.op==='memory-save'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        const sourceId=crypto.randomUUID();factory.domain.source(id,{id:sourceId,body:JSON.stringify(input.payload),kind:'configuration',namespace:input.namespace??'real'});
        try{factory.domain.save(id,{type:input.type,payload:input.payload,refs:[sourceId],truth:input.namespace==='fictional'?'fictional':'factual',namespace:input.namespace??'real'});}
        catch(error){journal.db.prepare('DELETE FROM source_record WHERE id=? AND agent=?').run(sourceId,id);throw error;}
      }else if(['persona-auto','persona-rollback','role-save'].includes(input.op)){throw new Error('PERSONA_AUTO_REMOVED');}
      else if(input.op==='delete-fixture-preview'){deletionPreview=await deletionLab.create();}
      else if(input.op==='delete-fixture-confirm'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        await deletionLab.request(input);deletionPreview=null;
      }
      else if(input.op==='delete-fixture-recover'){
        if(agent.active||agent.desired().desired!=='paused')throw new Error('PAUSE_REQUIRED');
        await deletionLab.recover();deletionPreview=null;
      }
      else if(input.op==='pause'){journal.put(id,'pauseRevision',journal.value(id,'pauseRevision',0)+1);await agent.control('paused');journal.put(id,'stopReason','user');}
      else if(['start','once'].includes(input.op)){
        if(input.expectedEpoch!==undefined&&input.expectedEpoch!==agent.desired().epoch)throw new Error('STALE_EPOCH');
        if(agent.active||agent.status==='running'||agent.desired().desired==='running')throw new Error('ALREADY_RUNNING');
        if(!state().canThink)throw new Error('BUDGET_EXHAUSTED');
        agent.requestedCycles=input.op==='once'?1:factory.autonomy.settings(id).enabled||config.interactiveOnly?0:config.maxCycles;journal.put(id,'stopReason',null);agent.wake=true;
        // Schedule the first periodic tick after the initial request interval.
        journal.tickAt(id,Date.now()+factory.config.intervalMs);await agent.control('running');
      }else if(input.op==='message'){
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>1024)throw new Error('INVALID_MESSAGE');
        const requestId=input.requestId??crypto.randomUUID();
        if(typeof requestId!=='string'||!/^[a-zA-Z0-9._:-]{8,128}$/.test(requestId))throw new Error('INVALID_REQUEST_ID');
        const target=input.target??'next-turn';if(!['next-turn','next-step'].includes(target))throw new Error('INVALID_MESSAGE');
        if(input.origin!==undefined&&(typeof input.origin!=='string'||!/^[a-zA-Z0-9._:-]{1,64}$/.test(input.origin)))throw new Error('INVALID_MESSAGE');
        const text=input.text.trim();let row=journal.db.prepare('SELECT * FROM user_request WHERE agent=? AND request_id=?').get(id,requestId);const newRequest=!row;
        if(row&&row.text!==text)throw new Error('REQUEST_ID_CONFLICT');
        if(row&&journal.value(id,'target:'+requestId,'next-turn')!==target)throw new Error('REQUEST_ID_CONFLICT');
        if(!row){
          if(agent.inbox.nextTurn.length+agent.inbox.nextStep.length>=10)throw new Error('INVALID_MESSAGE');
          row={request_id:requestId,message_id:crypto.randomUUID(),text,status:'pending'};
          let supplemented=false;
          journal.transaction(()=>{
            journal.db.prepare("INSERT INTO user_request VALUES(?,?,?,?,'pending')").run(id,requestId,text,row.message_id);
            journal.put(id,'target:'+requestId,target);
            if(input.origin!==undefined)journal.put(id,'origin:'+requestId,input.origin);
            supplemented=supersedeOwnerBatch(agent,target,{id:row.message_id,role:'user',content:[{type:'text',text}]});
          });
          if(supplemented){agent.cause={kind:'owner-supplement'};agent.cancelController?.abort(agent.cause);agent.wake=true;}
        }
        if(row.status==='pending')await deliverRequest(row);
        if(newRequest&&factory.autonomy.settings(id).enabled)factory.autonomy.event(id,'user:'+row.message_id,'user-input',{messageId:row.message_id,origin:input.origin??'web'});
        if(agent.active&&newRequest&&(target==='next-step'||(factory.autonomy.settings(id).enabled||config.interactiveOnly)&&agent.activeLane!=='foreground')){journal.set(id,agent.desired().desired);if(factory.autonomy.settings(id).enabled||config.interactiveOnly)journal.put(id,'autonomyPhase','preempting');agent.cause={kind:'user'};agent.cancelController?.abort(agent.cause);agent.wake=true;}
        if(newRequest&&!agent.active&&agent.desired().desired==='running'){agent.wake=true;agent.pump();}
      }else if(input.op==='retry'){
        if(agent.desired().desired!=='paused'||agent.active)throw new Error('PAUSE_REQUIRED');
        const messages=retryCandidates();if(!messages.length)throw new Error('NO_RETRYABLE_INPUT');
        for(const message of messages)if(![...agent.inbox.nextStep,...agent.inbox.nextTurn].some(m=>m.id===message.id))agent.send(message,'next-turn',false);
        await agent.flush();journal.reconcile(agent.session);journal.audit(id,'input-requeued',{messageIds:messages.map(m=>m.id)});
      }else if(input.op==='persona'){
        if(agent.desired().desired!=='paused'||agent.active||agent.status==='running')throw new Error('PAUSE_REQUIRED');
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>512)throw new Error('INVALID_PERSONA');factory.management.profileSave(id,{profile:{...factory.management.profile(id),corePrompt:input.text.trim()},expectedRevision:factory.management.revision(id)});
      }else if(input.op==='receipt'){
        const max=journal.db.prepare('SELECT max(seq) AS n FROM outbox WHERE agent=?').get(id).n??0;
        if(!Number.isSafeInteger(input.seq)||input.seq<0||input.seq>max)throw new Error('INVALID_RECEIPT');journal.put(id,'receipt',Math.max(input.seq,journal.value(id,'receipt',0)));
      }else throw new Error('UNKNOWN_OPERATION');
      return actionResult?{state:state(),action:actionResult}:mcpDiscovery?{state:state(),mcpDiscovery}:state();
    });
    scoped.connection.fetch.register({path:'/api/become-human/state',methods:['GET'],requestBody:'buffered',fetch:async()=>Response.json(state(),{headers:{'Cache-Control':'no-store'}})});
    scoped.connection.fetch.register({path:'/api/become-human/read',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{const raw=await request.text();if(Buffer.byteLength(raw)>8192)throw new Error('TOO_LARGE');const input=JSON.parse(raw);storage.guard(id);if(input.sessionId&&input.sessionId!==id)throw new Error('STALE_SESSION');return Response.json(await factory.management.read(id,input));}catch(e){return Response.json({error:/^[A-Z_]{3,64}$/.test(e.message)?e.message:'READ_FAILED'},{status:400});}}});
    scoped.connection.fetch.register({path:'/api/become-human/events',methods:['GET'],requestBody:'buffered',fetch:async request=>{
      const after=Number(new URL(request.url).searchParams.get('after')??0);
      if(!Number.isSafeInteger(after)||after<0)return Response.json({error:'INVALID_CURSOR'},{status:400});
      storage.guard(id);
      const rows=journal.db.prepare('SELECT * FROM outbox WHERE agent=? AND seq>? ORDER BY seq LIMIT 100').all(id,after).map(row=>{
        const request=row.event_key?.startsWith('user:')?journal.db.prepare('SELECT request_id FROM user_request WHERE agent=? AND message_id=?').get(id,row.event_key.slice(5)):undefined;
        const assistant=row.event_key?.startsWith('assistant:')?agent.session.snapshotEvents().find(e=>e.type==='assistant/message'&&e.data.message.id===row.event_key.slice(10)):undefined;
        const attempt=assistant?journal.db.prepare('SELECT request FROM attempt WHERE agent=? AND turn=? ORDER BY started DESC LIMIT 1').get(id,assistant.data.turn):row.event_key?.startsWith('wait:')?journal.db.prepare('SELECT request FROM attempt WHERE agent=? AND id=?').get(id,row.event_key.slice(5)):undefined;
        const admittedIds=attempt?(JSON.parse(attempt.request).admittedIds??[]):assistant?journal.value(id,'local-admitted:'+assistant.data.message.id,[]):[];
        const replyToRequests=admittedIds.flatMap(mid=>{const r=journal.db.prepare('SELECT request_id FROM user_request WHERE agent=? AND message_id=?').get(id,mid);return r?[r.request_id]:[];});
        return {...row,origin:request?journal.value(id,'origin:'+request.request_id,'web'):'agent',replyToRequests,...(assistant?{presentation:replyPresentation(journal,id,assistant,row.text)}:{})};
      });
      return Response.json({sessionId:id,events:rows,latest:journal.db.prepare('SELECT max(seq) AS n FROM outbox WHERE agent=?').get(id).n??0},{headers:{'Cache-Control':'no-store'}});
    }});
    scoped.connection.fetch.register({path:'/api/become-human/control',methods:['POST'],requestBody:'streaming',fetch:async request=>{
      const size=Number(request.headers.get('content-length')??0);if(size>786432)return Response.json({error:'TOO_LARGE'},{status:413});
      try{
        const reader=request.body?.getReader();let parts=[],bytes=0;
        if(reader)while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>786432){await reader.cancel();return Response.json({error:'TOO_LARGE'},{status:413});}parts.push(Buffer.from(value));}
        const text=Buffer.concat(parts).toString('utf8');return Response.json(await mutate(JSON.parse(text)));
      }catch(e){return Response.json({error:['INVALID_REQUEST','INVALID_MESSAGE','INVALID_PERSONA','INVALID_RECEIPT','INVALID_REQUEST_ID','REQUEST_ID_CONFLICT','ALREADY_RUNNING','PAUSE_REQUIRED','NO_RETRYABLE_INPUT','BUDGET_EXHAUSTED','UNKNOWN_OPERATION','NOT_DISPOSABLE_FIXTURE','INVALID_DELETE_CONFIRMATION','DELETE_PREVIEW_STALE','SESSION_RETIRED','LINKED_ARTIFACT','DELETE_PENDING','STALE_SESSION','INVALID_MEMORY','SENSITIVE_MEMORY_REFUSED','INVALID_PERSONA_FIELD','INVALID_EVIDENCE','UNSUPPORTED_CLAIM','INTERACTIVE_ONLY','STALE_EPOCH'].includes(e.message)||/^(?:COGNITION_|MATTER_|ATTENTION_|REFLECTION_|OWNER_MATTER_|RUNTIME_MATTER_|STALE_|INVALID_|BUNDLED_|SKILL_|MODEL_ROUTE_|MEMORY_|USE_LEARNING_|NOTE_|TASK_|CONFIGURATION_|PROFILE_|GOAL_|ACTION_|REPORT_|CAPABILITY_|TOOL_|MCP_|CUSTOM_MCP_|DSH_|BROWSER_)/.test(e.message)||/^(INVALID_TASK_RETRY|INVALID_AUTONOMY_SETTINGS|INVALID_SEARCH_SETTINGS|INVALID_LEARNING_SOURCE|SOURCE_URL_NOT_ALLOWED|SIGNED_CONTROL_REQUIRED|INVALID_RESOURCE_GRANT|RESOURCE_GRANT_NOT_FOUND|INVALID_LEARNING_FEEDBACK|LEARNING_NOTE_NOT_FOUND)$/.test(e.message)?e.message:'CONTROL_FAILED'},{status:400});}
    }});
    scoped.webServer.register({path:'/become-human',kind:'exact',handler:async(req,res)=>{
      if(!scoped.connection.authorizeIndex(req,res))return;
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      const html=await fs.readFile(new URL('./panel.html',import.meta.url));
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(html);
    }});
    scoped.webServer.register({path:'/become-human-client.js',kind:'exact',handler:async(req,res)=>{
      const denied=scoped.connection.requestRejection(req);if(denied){res.writeHead(denied);res.end();return;}
      const js=await fs.readFile(new URL('./client.js',import.meta.url));res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(js);
    }});
    scoped.webServer.tapIndex(html=>html.replace('</body>','<a href="/become-human" style="position:fixed;right:18px;bottom:14px;z-index:100000;background:#143b34;color:white;padding:10px 16px;border-radius:10px;font:14px system-ui">自主 Agent 测试</a></body>'));
    // Persist a private one-use launch URL without writing it to tool output.
    await fs.writeFile(path.join(root,'launch.json'),JSON.stringify({url:scoped.connection.authenticatedUrl('http://127.0.0.1:'+scoped.webServer.port+'/')}));
    scoped.effect(()=>async()=>{await operations.catch(()=>{});await retirement.close();await handle.dispose();});
  });
}
