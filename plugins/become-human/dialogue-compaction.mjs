const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parse=text=>JSON.parse(text.trim().replace(/^```(?:json)?\s*/iu,'').replace(/\s*```$/u,''));
const codeOf=error=>/^[A-Z_]{3,64}$/u.test(error?.code??error?.message??'')?(error.code??error.message):'CONVERSATION_SUMMARY_FAILED';
export const conversationSummaryPolicy='你在维护当前唯一会话的滚动工作摘要，不是在回答主人，也不创建目标、提醒、记忆事实、权限或人格变化。只压缩input.turns里实际提供的原文，不调用工具，不扩展常识。role=user是主人当时说的，role=assistant只是助手曾说过的内容，不证明事实、承诺已执行或现实经历。保留主题、实际选择、未解决问题及更正；对同一事项采用较新主人更正，不能用旧助手复述推翻主人。虚构开发片段只在该开发scope有效，不变成真实偏好或经历。图片只保留“曾附图/需要重附”这类状态，不能凭文字猜图中内容。每条只引用本批真实sourceIds，原始ID逐字复制；不编造引文，不输出思维过程。按outputContract仅返回一个JSON对象，topics、decisions、openQuestions、corrections四个数组，不加其他字段；每项为{text,sourceIds}，没依据的类别可以为空。只输出四个类别数组；outputContract中的限值、onlySourceIds和outputKeys是约束说明，不能复制成输出字段。每类最多3项，单项text最多240个字符、单项sourceIds为1至8个本批真实ID且不能重复，四类text合计最多700字符，序列化结果最多8192 UTF-8字节；自然文字总计尽量不超过350汉字，避免逐句照抄或重复相同内容；未完成事项不要写成已完成。';

/** One optional serial model call on the parent's existing foreground interval. */
export async function compactConversation(agent,signal,{turn,epoch,admittedIds=[]},request){
  const store=agent.factory.conversationSummary,j=agent.factory.journal;
  if(!store||typeof request!=='function')return {status:'unavailable'};
  let job,response;
  try{
    signal.throwIfAborted();job=store.prepare(agent,{admittedIds,recentTurnLimit:agent.factory.management?.execution(agent.id).context.historyLimit??8});
    if(!job)return {status:'unchanged'};
    j.put(agent.id,'autonomyPhase','compacting-conversation');
    const messages=[{role:'system',content:[{type:'text',text:conversationSummaryPolicy}]},{role:'user',content:[{type:'text',text:JSON.stringify({input:job.input,outputContract:job.outputContract,scope:job.scope})}]}];
    const size=Buffer.byteLength(JSON.stringify(messages),'utf8')+256,budget=null;
    Object.defineProperty(messages,'contextReport',{value:{version:2,kind:'conversation-summary',lane:'conversation-summary',time:Date.now(),estimatedInput:size,required:size,inputBytes:size,budget,scope:job.scope,sourceTurnCount:job.coveredTurnIds?.length??job.input.turns.length,sourceMessageCount:job.sourceIds?.length??0,estimate:'utf8-bytes-plus-framing'},enumerable:false});
    // Empty admittedIds is deliberate: older textual evidence is compressed,
    // never this turn's image bytes. The normal owner revision gate still runs.
    response=await request(agent,signal,{turn,epoch,lane:'foreground',purpose:'conversation-summary',admittedIds:[],taskId:'conversation-summary:'+job.id,messages});
    signal.throwIfAborted();if(agent.desired().epoch!==epoch)throw new Error('STALE_EPOCH');
    let output;try{output=parse(response.text);}catch{throw Object.assign(new Error('INVALID_CONVERSATION_SUMMARY'),{validationDiagnostic:{version:1,field:'output',reason:'invalid-json'}});}if(!plain(output))throw Object.assign(new Error('INVALID_CONVERSATION_SUMMARY'),{validationDiagnostic:{version:1,field:'output',reason:'object-required'}});
    const result=store.commit(agent,job,output);j.audit(agent.id,'conversation-summary-completed',{attemptId:response.rid,scope:job.scope,version:result?.version,sourceTurnCount:job.coveredTurnIds?.length??job.input.turns.length,origin:'owner',type:'model'});
    return {status:'updated',version:result?.version};
  }catch(error){
    if(signal.aborted||agent.desired().epoch!==epoch){
      // A typing supplement must not repeatedly pay to compress the identical
      // abandoned source batch. A new basis may be planned; this one is held.
      if(job)try{store.interrupt?.(agent,job);if(response)j.endAttempt(response.rid,{state:'cancelled',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:'SUMMARY_SUPERSEDED',textChars:response.text.length,reasoningChars:response.reasoningChars});}catch{}
      throw error;
    }
    const code=codeOf(error);
    const validationDiagnostic=error.validationDiagnostic??null;
    if(response)j.endAttempt(response.rid,{state:'validation-rejected',usage:response.usage,usageConfidence:response.usage?'reported':'unknown',error:code,textChars:response.text.length,reasoningChars:response.reasoningChars,...(validationDiagnostic?{failureFacts:{validationDiagnostic}}:{})});
    if(job){store.fail(agent,job,code);j.audit(agent.id,'conversation-summary-held',{attemptId:response?.rid,scope:job.scope,code,validationDiagnostic,origin:'owner',modelRetried:false,chatContinues:true});}
    return {status:'held',code};
  }finally{if(!signal.aborted&&agent.desired().epoch===epoch)j.put(agent.id,'autonomyPhase','dialogue');}
}
