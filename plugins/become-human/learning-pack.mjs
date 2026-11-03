import {learningOpportunitySnapshot,learningExecutionContext} from './learning-service.mjs';

export const learningKinds=new Set(['research','learn-ai']);
// Migration adapter for durable pre-pack tasks. New third-party actions still
// use humanBehaviors. There is deliberately no bundled/default provider.
export class LearningPack {
  constructor(){this.provider=null;}
  register(descriptor){
    if(this.provider||descriptor?.version!==1||['collect','prepare','execute'].some(k=>typeof descriptor[k]!=='function'))throw Error('INVALID_LEARNING_PACK');
    const provider=Object.freeze({...descriptor});this.provider=provider;
    return ()=>{if(this.provider===provider)this.provider=null;};
  }
  catalog(){return this.provider?[{id:'deep-learning',version:1,title:'探索与学习',kind:'optional-workflow',taskKinds:[...learningKinds]}]:[];}
  available(settings){return !!this.provider&&settings.learningEnabled===true;}
  collect(agent,snapshot){
    if(!this.available(snapshot.settings))return;
    let rows;
    try{rows=this.provider.collect(learningOpportunitySnapshot(agent,snapshot));
      if(!Array.isArray(rows)||rows.length>32||rows.some(row=>!learningKinds.has(row?.kind)||typeof row.question!=='string'||!row.question.trim()||row.question.length>240))throw Error('INVALID_LEARNING_OPPORTUNITIES');
    }catch(error){agent.factory.journal.audit(agent.id,'learning-provider-held',{code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'LEARNING_PROVIDER_FAILED'});return;}
    for(const row of rows)snapshot.offer(row);
  }
  hold(agent,task,settings){
    if(!learningKinds.has(task.kind)&&task.kind!=='share-insight')return false;
    const version=task.checkpoint.learningPackVersion??1;
    const reason=!this.provider?'LEARNING_PACK_UNAVAILABLE':!settings.learningEnabled?'LEARNING_DISABLED':version!==this.provider.version?'LEARNING_PACK_CHANGED':null;
    const store=agent.factory.autonomy;
    if(reason){if(task.checkpoint.learningHold!==reason){store.update(task.id,'suspended',{...task.checkpoint,learningHold:reason});agent.factory.journal.audit(agent.id,'learning-task-held',{taskId:task.id,code:reason});}return true;}
    if(task.checkpoint.learningHold){const {learningHold,...checkpoint}=task.checkpoint;store.update(task.id,task.status,checkpoint);}
    return false;
  }
  workflow(){
    const provider=this.provider;if(!provider)throw Error('LEARNING_PACK_UNAVAILABLE');
    const invoke=async(name,ctx)=>{
      const guard=()=>{ctx.valid(ctx.agent,ctx.signal,ctx.epoch,ctx.task.persona_version);if(this.provider!==provider||!this.available(ctx.agent.factory.autonomy.settings(ctx.agent.id)))throw Error('LEARNING_PACK_UNAVAILABLE');if((ctx.task.checkpoint.learningPackVersion??1)!==provider.version)throw Error('LEARNING_PACK_CHANGED');};
      guard();const scoped=learningExecutionContext(ctx,guard);
      return provider[name](scoped);
    };
    return {prepare:ctx=>invoke('prepare',ctx),execute:ctx=>invoke('execute',ctx)};
  }
}
