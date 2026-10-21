export function registerReportCapability(registry,actions,journal){
  registry.register('list-learning-notes',{version:1,description:'列出当前 Human 可用于报告的有效学习笔记编号、标题和概要。',backend:'learning-notes',effect:'read',scope:'current-human-learning',timeoutMs:5000,maxResultBytes:32768,retrySafe:true,autonomous:false,inputSchema:{type:'object',additionalProperties:false,properties:{},required:[]},execute:async(input,signal,context)=>{signal.throwIfAborted();return actions.eligibleNotes(context.agent,{limit:32});}});
  return registry.register('write-learning-report',{
    version:1,title:'保存学习报告',description:'把有效学习笔记汇总为受管本地报告；先预览内容、路径与摘要，再批准本次保存。',backend:'managed-report',effect:'write',scope:input=>({kind:'managed-report',noteIds:input.noteIds}),scopeDescription:'本 Human 的受管产物目录',timeoutMs:30000,maxResultBytes:8192,retrySafe:false,autonomous:false,
    inputSchema:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:240},noteIds:{type:'array',minItems:1,maxItems:8,items:{type:'string',minLength:1,maxLength:128}}},required:['title','noteIds']},
    prepare(input,context){const action=actions.proposeReport(context.agent,{requestId:'cap-'+context.jobId,title:input.title,noteIds:input.noteIds});journal.put(context.agent,'capabilityOwnedAction:'+action.id,{jobId:context.jobId});return {actionId:action.id,digest:action.digest,bytes:action.bytes,path:action.path,content:action.content};},
    async execute(input,signal,context){
      const prepared=context.prepared;if(!prepared?.actionId)throw new Error('INVALID_CAPABILITY_PREVIEW');
      const valid=()=>{signal.throwIfAborted();journal.assertAdmitted(context.agent);context.valid();};valid();
      let action=actions.get(context.agent,prepared.actionId);if(action.digest!==prepared.digest||action.path!==prepared.path||!action.sourceValid)throw new Error('ACTION_SOURCE_CHANGED');
      if(action.status==='completed'){if(!actions.verifyReceipt(context.agent,action.id))throw new Error('ACTION_ARTIFACT_TAMPERED');return {actionId:action.id,status:'completed',receipt:action.receipt};}
      if(action.status==='proposed')action=actions.approve(context.agent,action.id,{expectedVersion:action.version,digest:prepared.digest,capabilityJobId:context.jobId,approvalExpiresAt:context.approvalExpires});
      await journal.safety.anchor();valid();
      action=await actions.execute(context.agent,action.id,{signal,valid});
      if(action.status!=='completed')throw new Error('CAPABILITY_OUTCOME_UNKNOWN');
      if(!actions.verifyReceipt(context.agent,action.id))throw new Error('ACTION_ARTIFACT_TAMPERED');return {actionId:action.id,status:'completed',receipt:action.receipt};
    },
  });
}
