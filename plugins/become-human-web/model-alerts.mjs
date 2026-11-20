import {modelFailureDiagnostic,explainModelFailure,transientModelFailure} from './runtime/model-failure.mjs';
const object=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value??'null')??{};}catch{return {};}};
export function activeModelAlerts(state){
  const result=[];
  for(const [scope,code]of [['autonomous',state.autonomy?.paused?state.autonomy.error:null],['foreground',state.lastError]]){
    if(!code)continue;
    const matches=lane=>scope==='foreground'?lane==='foreground':lane!=='foreground';
    let entry=Object.values(state.modelFailures??{}).filter(row=>matches(row.lane)&&row.code===code).sort((a,b)=>b.at-a.at)[0];
    if(!entry){
      const row=(state.attempts??[]).find(row=>row.error===code&&matches(object(row.request).lane??(row.trigger==='autonomous-tick'?'selection':'foreground')));
      const config=object(row?.config),facts=object(row?.failure_facts??row?.failureFacts);
      const diagnostic=facts.diagnostic??modelFailureDiagnostic({status:facts.httpStatus??facts.status},code,facts);
      entry={...diagnostic,code,attemptId:row?.id,at:row?.ended??row?.started,provider:config.provider,model:config.model,streamFinish:facts.streamFinish,textChars:facts.textChars,reasoningChars:facts.reasoningChars,legacy:!facts.diagnostic};
    }
    const attempt=(state.attempts??[]).find(row=>row.id===entry.attemptId);
    const details=explainModelFailure({...entry,purpose:entry.purpose??attempt?.purpose??object(attempt?.request).purpose});
    const chatAvailable=scope==='foreground'&&state.desired==='running'&&!state.retiring&&transientModelFailure(details);
    result.push({...details,scope,chatAvailable});
  }
  return result;
}
