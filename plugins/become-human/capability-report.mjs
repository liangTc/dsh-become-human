import {reportMaterialMatches} from './report-materials.mjs';
export function registerReportCapability(registry,actions,journal){
  registry.register('list-learning-notes',{version:2,description:'生成报告前先按本轮主题 query 查找已保存的有效笔记；空结果表示尚无对应笔记，不能拿其他主题替代。网页读取本身不产生学习笔记。匹配只用于检索，不证明语义正确。',backend:'learning-notes',effect:'read',scope:'current-human-learning',timeoutMs:5000,maxResultBytes:16384,retrySafe:true,autonomous:false,inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:240}},required:[]},execute:async(input,signal,context)=>{signal.throwIfAborted();const all=actions.eligibleNotes(context.agent,{limit:100}),matched=input.query?.trim()?all.items.filter(n=>reportMaterialMatches(input.query,n)):all.items;return {items:matched.slice(0,6),total:matched.length,hasMore:matched.length>6,query:input.query??'',lexicalOnly:true,automaticMemoryWrite:false};}});
  return registry.register('write-learning-report',{
    version:1,title:'保存学习报告',description:'把有效学习笔记及人工批注汇总为受管本地报告；先预览内容、路径与摘要，再批准本次保存。批注变更后需要新的预览和授权。',backend:'managed-report',effect:'write',scope:input=>({kind:'managed-report',noteIds:input.noteIds}),scopeDescription:'本 Human 的受管产物目录',timeoutMs:30000,maxResultBytes:8192,retrySafe:false,autonomous:false,
    inputSchema:{type:'object',additionalProperties:false,properties:{title:{type:'string',minLength:1,maxLength:240},noteIds:{type:'array',minItems:1,maxItems:8,items:{type:'string',minLength:1,maxLength:128}}},required:['title','noteIds']},
    prepare(input,context){const action=actions.proposeReport(context.agent,{requestId:'cap-'+context.jobId,title:input.title,noteIds:input.noteIds});journal.put(context.agent,'capabilityOwnedAction:'+action.id,{jobId:context.jobId});return {actionId:action.id,digest:action.digest,bytes:action.bytes,path:action.path,content:action.content,reportVersion:action.reportVersion,annotationScope:action.annotationScope,ownerAnnotations:action.ownerAnnotations};},
    cancelPrepared(input,context){
      const actionId=context.prepared?.actionId;if(!actionId)throw new Error('INVALID_CAPABILITY_PREVIEW');
      if(journal.value(context.agent,'capabilityOwnedAction:'+actionId,null)?.jobId!==context.jobId)throw new Error('ACTION_MANAGED_BY_CAPABILITY');
      const action=actions.get(context.agent,actionId);
      // A dispatched or completed action needs outcome reconciliation, never
      // silent cancellation or deletion of its actual file.
      if(['executing','completed'].includes(action.status))throw new Error('CAPABILITY_OUTCOME_UNKNOWN');
      actions.cancel(context.agent,actionId,{expectedVersion:action.version});
    },
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
