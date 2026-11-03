import {createHash} from 'node:crypto';
import {plain} from './capability-schema.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

// Capability registration is reflected dynamically: adding/removing a tool
// does not require editing the scheduler. Only explicitly autonomous grants
// are offered. External model sessions retain their separate budget boundary.
export function syncCapabilityBehaviors(factory,id){
  if(!factory.behaviors||!factory.tools?.catalog)return;
  const registered=factory.capabilityBehaviorDisposers??=new Map();
  const eligible=factory.tools.catalog(id,{origin:'autonomous'}).filter(c=>c.available&&!c.externalModel),seen=new Set();
  for(const cap of eligible){
    const behaviorId='tool.'+cap.id,fingerprint=hash(cap);seen.add(behaviorId);
    if(registered.get(behaviorId)?.fingerprint===fingerprint)continue;
    registered.get(behaviorId)?.dispose();
    const dispose=factory.behaviors.register(behaviorId,{version:cap.version,title:cap.title.slice(0,120),description:(cap.description||cap.title).slice(0,1000),inputSchema:cap.inputSchema,
      available:agent=>factory.tools.catalog(agent.id,{origin:'autonomous'}).some(c=>c.id===cap.id&&c.available&&!c.externalModel),
      opportunities:()=>[{question:`按当前兴趣、关注或目标决定是否使用能力：${cap.title}`.slice(0,240)}],
      execute:async(agent,input,context)=>{
        const tools=factory.tools,journal=factory.journal,task=context.task,roundId=task.checkpoint.roundId??task.id,requestId='behavior:'+task.id+':'+roundId;
        const failureKey='behavior-capability-failure:'+hash(canonical({tool:cap.id,input})),prior=journal.value(agent.id,failureKey,null);
        if(prior){
          const explicitTaskRetry=prior.taskId===task.id&&prior.roundId!==roundId;
          let explicitGoalRetry=false;
          if(task.checkpoint.goal)try{const goal=factory.goals.get(agent.id,task.checkpoint.goal.id),step=goal.steps.find(row=>row.id===task.checkpoint.goal.stepId);explicitGoalRetry=goal.status==='active'&&step?.attempts?.length>1&&step.taskId===task.id;}catch{}
          if(prior.outcome==='unknown'||!explicitTaskRetry&&!explicitGoalRetry)return {status:'failed',summary:prior.outcome==='unknown'?'相同操作此前结果未知，需先人工核对；没有重新执行。':'相同操作此前失败，等待明确重试；没有重新执行。',error:prior.outcome==='unknown'?'CAPABILITY_OUTCOME_UNKNOWN':'CAPABILITY_RETRY_REQUIRED',priorJobId:prior.jobId};
        }
        let job=tools.submit(agent.id,{tool:cap.id,input,requestId},{origin:'autonomous',taskId:context.task.id});
        if(['queued','suspended'].includes(job.status))job=await tools.execute(agent.id,job.id,{signal:context.signal,valid:context.valid,taskId:context.task.id});
        if(['awaiting-approval','queued','suspended','running'].includes(job.status))return {status:'waiting',summary:job.status==='awaiting-approval'?'已准备操作，等待既有审批流程批准。':'能力操作尚未完成，保留原作业。',jobId:job.id};
        if(job.status!=='completed'){
          journal.put(agent.id,failureKey,{taskId:task.id,roundId,jobId:job.id,outcome:job.status,at:Date.now()});
          return {status:job.status==='unknown'?'unknown':'failed',summary:'能力操作未确认完成。',jobId:job.id,error:job.error??job.status};
        }
        if(prior)journal.put(agent.id,failureKey,null);
        const encoded=JSON.stringify(job.result),preview={text:encoded.slice(0,1200),truncated:encoded.length>1200,evidenceStatus:'tool-returned-unverified'};
        return {status:'completed',summary:`已完成能力调用：${cap.title.slice(0,120)}。结果为工具返回内容，尚不证明用户满意或外部资料结论成立。`,jobId:job.id,resultDigest:hash(job.result),preview};
      }});
    registered.set(behaviorId,{fingerprint,dispose});
  }
  for(const [behaviorId,row] of registered)if(!seen.has(behaviorId)){row.dispose();registered.delete(behaviorId);}
}

export function behaviorTaskReady(agent,task){
  const jobId=task.checkpoint.behaviorResult?.jobId;if(!jobId)return true;
  try{return !['awaiting-approval','running'].includes(agent.factory.tools.get(agent.id,jobId).status);}catch{return true;}
}
