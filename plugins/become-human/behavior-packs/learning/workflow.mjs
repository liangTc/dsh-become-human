// This optional package owns sequencing. The host owns evidence, persistence,
// permission checks, model accounting, cancellation and the one execution lane.
export async function prepare(ctx){
  if(ctx.task.checkpoint.sourceSpec&&!ctx.task.checkpoint.source){
    const spec=ctx.task.checkpoint.sourceSpec;ctx.markSourceChecked(spec.url);
    try{
      const source=await ctx.fetchSource(spec);ctx.valid();source.requestedUrl=spec.url;
      if(ctx.alreadyLearned(source)&&!ctx.task.checkpoint.correction){ctx.cancelUnchanged();return false;}
      ctx.saveSource(source);
    }catch(error){if(ctx.signal.aborted)throw error;ctx.valid();ctx.failSource(error);return false;}
  }
  return true;
}
export async function execute(ctx){
  if(ctx.task.kind==='research'&&!ctx.task.checkpoint.source){if(!await ctx.discover())return;ctx.valid();}
  ctx.phase('executing');
  ctx.response=ctx.cachedDraft()??await ctx.executeModel();ctx.valid();
  if(ctx.task.checkpoint.source&&ctx.response.text==='[WAIT]'){ctx.rejectInsufficient('executor-wait');ctx.response=null;return;}
  if(!ctx.task.checkpoint.source)throw Error('LEARNING_SOURCE_REQUIRED');
  await ctx.commitValidated();ctx.response=null;
}
