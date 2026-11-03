export async function executeRegisteredBehavior(ctx){
  const {agent,signal,turn,epoch,phase,valid,modelRequest,discoverSource,rejectInsufficientEvidence}=ctx;let task=ctx.task,response=ctx.response;const f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id,settings=store.settings(id);
  try{
        const references=f.behaviors.eventReferences?.(agent,task.checkpoint.behaviorId,task.checkpoint.plan?.input)??[],prior=task.checkpoint.pluginEventIds??[];
        if(prior.length&&references.length&&(prior.length!==references.length||prior.some(id=>!references.includes(id))))throw Error('BEHAVIOR_EVENT_REFERENCES_CHANGED');
        if(references.length&&!prior.length){
          // Explicit goal steps may use the same event-backed behavior without
          // passing through its opportunity callback. Bind before side effects.
          j.transaction(()=>{f.pluginEvents.claim(id,references);store.update(task.id,task.status,{...task.checkpoint,pluginEventIds:references,eventIds:[...new Set([...(task.checkpoint.eventIds??[]),...references])]});});
          task=store.getTask(task.id);agent.activeCognitionTask=task;
        }
        const result=await f.behaviors.execute(agent,task,{signal,strategies:f.experience?.strategies.forTask(id,task)??[],valid:()=>valid(agent,signal,epoch,task.persona_version),request:messages=>modelRequest(agent,signal,{turn,epoch,lane:'executor',taskId:task.id,messages}),turn,epoch});
        valid(agent,signal,epoch,task.persona_version);
        j.transaction(()=>{store.update(task.id,result.status==='completed'?'completed':result.status==='waiting'?'suspended':'failed',{...task.checkpoint,behaviorResult:result,...(result.status==='failed'||result.status==='unknown'?{reason:result.error??'BEHAVIOR_EXECUTION_FAILED'}:{})});if(result.status!=='waiting')store.completeEvents(id,task.checkpoint.eventIds??[]);});
        if(result.status==='completed')store.defer(id,task,'behavior-completed',settings.wakeIntervalMs);
        j.audit(id,'behavior-result',{taskId:task.id,behaviorId:task.checkpoint.behaviorId,status:result.status,jobId:result.jobId??null});
        phase(result.status==='waiting'?'waiting-approval':'idle');return;

  }finally{ctx.task=task;ctx.response=response;}
}
