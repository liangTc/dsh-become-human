import {createHash} from 'node:crypto';
import {searchPublicWeb,searchQuery} from './research.mjs';
import {fetchResearch,sourceFailureDiagnostic} from './learning.mjs';
const key=value=>createHash('sha256').update(value).digest('hex');
export async function discoverPublicSource(agent,signal,task,settings,epoch,{search=searchPublicWeb,read=fetchResearch,valid}={}){
  const {journal:j,autonomy:store}=agent.factory,id=agent.id,started=Date.now();
  const phase=value=>j.put(id,'autonomyPhase',value);
  try{
    let discovery=task.checkpoint.discovery;
    if(!discovery){
      phase('searching');const query=searchQuery(task.checkpoint.plan.searchQuery);
      discovery=await search(query,settings,signal,{question:task.checkpoint.plan.question,alternateQuery:task.checkpoint.plan.alternateSearchQuery});valid(agent,signal,epoch,task.persona_version);
      // Persist only bounded public search metadata, not the search page body.
      store.update(task.id,'executing',{...task.checkpoint,discovery});task=store.getTask(task.id);
      for(const step of discovery.querySteps??[])j.audit(id,'research-query-step',{taskId:task.id,step:step.step,queryHash:key(step.query),reason:step.reason,state:step.state,code:step.code??null,parsedCount:step.parsedCount??0,relevantCount:step.relevantCount??0});
      j.audit(id,'research-searched',{taskId:task.id,provider:discovery.provider,queryHash:key(discovery.query),originalQueryHash:key(query),refinement:discovery.refinement??null,resultCount:discovery.results.length,searchedAt:discovery.searchedAt});
    }
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
    let reads=task.checkpoint.researchReads??0;const batchEnd=Math.min(reads+3,discovery.results.length);
    while(reads<batchEnd){
      const row=discovery.results[reads],rank=reads+1;phase('checking-source');
      // Advance the checkpoint only after a completed read/failure, so an
      // interrupted request can be retried under the next epoch.
      let source,readCode=null,sourceDiagnostic=null;
      try{source=await read({...row,topic:task.checkpoint.plan.question??discovery.originalQuery??discovery.query,discovery:{query:row.searchContext?.query??discovery.query,...(discovery.originalQuery?{originalQuery:discovery.originalQuery,refinement:discovery.refinement}:{}),provider:row.searchContext?.provider??discovery.provider,searchedAt:row.searchContext?.searchedAt??discovery.searchedAt,resultRank:rank,queryStep:row.searchContext?.step??1,queryStepsCount:discovery.querySteps?.length??1,sourceSignals:row.sourceSignals??null,relevance:row.relevance??null}},deadline);}
      catch(error){if(signal.aborted)throw error;readCode=/^[A-Z_]+$/.test(error.message)?error.message:'SOURCE_FETCH_FAILED';sourceDiagnostic=sourceFailureDiagnostic(error);j.audit(id,'research-read-failed',{taskId:task.id,sourceKey:key(row.url),rank,code:readCode,sourceDiagnostic});}
      valid(agent,signal,epoch,task.persona_version);reads++;
      const alreadyLearned=source&&j.value(id,'learned:'+key(source.url),null)===source.digest;
      const step={rank,sourceKey:key(row.url),at:Date.now(),state:readCode?'failed':alreadyLearned?'unchanged-source':'readable',code:readCode??(alreadyLearned?'SOURCE_ALREADY_LEARNED':null),sourceType:source?.signals?.type??row.sourceSignals?.type??'unknown',...(sourceDiagnostic?{sourceDiagnostic}:{})};
      const checkpoint={...task.checkpoint,researchReads:reads,researchReadSteps:[...(task.checkpoint.researchReadSteps??[]),step].slice(-12)};
      j.audit(id,'research-read-step',{taskId:task.id,...step});
      if(source&&!alreadyLearned){
        source.requestedUrl=row.url;checkpoint.source=source;store.update(task.id,'executing',checkpoint);
        j.audit(id,'source-fetched',{taskId:task.id,url:source.url,digest:source.digest,partial:source.partial,origin:'open-search',rank,sourceSignals:source.signals??null,relevance:row.relevance??null});
        const recent=j.value(id,'recentResearch',[]);recent.push({question:discovery.query,url:source.url,time:Date.now()});j.put(id,'recentResearch',recent.slice(-12));
        return store.getTask(task.id);
      }
      store.update(task.id,'executing',checkpoint);task=store.getTask(task.id);
    }
    if(reads<discovery.results.length){store.update(task.id,'suspended');j.put(id,'autonomyWait','research-read-checkpoint');phase('waiting');return null;}
    j.put(id,'autonomyWait','research-no-new-readable-evidence');
    store.defer(id,task,'research-no-new-readable-evidence',settings.sourceIntervalMs);store.update(task.id,'cancelled',{...task.checkpoint,reason:'research-no-new-readable-evidence'});phase('waiting');return null;
  }catch(error){
    if(signal.aborted)throw error;
    const code=/^[A-Z_]{3,64}$/.test(error.message)?error.message:'SEARCH_UNAVAILABLE';
    const searchTrace=(error.searchTrace??[]).slice(0,2).map(step=>({step:step.step,queryHash:typeof step.query==='string'?key(step.query):null,reason:step.reason,state:step.state,code:step.code??null,parsedCount:step.parsedCount??0,relevantCount:step.relevantCount??0}));
    for(const step of searchTrace)j.audit(id,'research-query-step',{taskId:task.id,...step});
    store.defer(id,task,code,settings.sourceIntervalMs);store.update(task.id,'failed',{...task.checkpoint,reason:code,searchFailure:{code,steps:searchTrace}});j.put(id,'autonomyWait',code);j.audit(id,'research-unavailable',{taskId:task.id,code,querySteps:searchTrace.length,nextAction:code==='SEARCH_CHALLENGE_REQUIRED'?'configure-another-public-search-provider':'inspect-public-search-and-read-steps'});phase('waiting');return null;
  }finally{j.put(id,'lastResearchAt',started);}
}
