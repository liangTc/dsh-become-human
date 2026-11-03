export async function prepareGoalReport(ctx){
  const {agent,signal,turn,epoch,phase,valid,modelRequest,discoverSource,rejectInsufficientEvidence}=ctx;let task=ctx.task,response=ctx.response;const f=agent.factory,j=f.journal,store=f.autonomy,id=agent.id,settings=store.settings(id);
  try{
        const ref=task.checkpoint.goal,p=task.checkpoint.reportProposal;
        const action=f.actions.proposeReport(id,{...p,goal:{id:ref.id,stepId:ref.stepId}});f.goals.attachAction(id,ref,action.id);
        store.update(task.id,'completed',{...task.checkpoint,actionId:action.id});phase('waiting-approval');return;

  }finally{ctx.task=task;ctx.response=response;}
}
