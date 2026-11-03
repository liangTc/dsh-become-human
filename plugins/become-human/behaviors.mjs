import {createHash} from 'node:crypto';
import {assertCapabilitySchema,validateCapabilityInput,plain} from './capability-schema.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw new Error(code);};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():fail('INVALID_BEHAVIOR');
export const behaviorPolicy=Object.freeze({version:1,singleExecutionLane:true,waitAllowed:true,trustedCodeOnly:true,resultsAreNotOwnerSatisfaction:true});

// Trusted code registers behavior lifecycle, never a second Session or runner.
// Every invocation is made by the existing autonomous execution gate.
export class BehaviorRegistry {
  constructor(){this.providers=new Map();}
  register(id,descriptor){
    if(typeof id!=='string'||!/^[a-z][a-z0-9._:-]{0,159}$/u.test(id)||this.providers.has(id)||!plain(descriptor)||!Number.isSafeInteger(descriptor.version)||descriptor.version<1||typeof descriptor.execute!=='function')fail('INVALID_BEHAVIOR');
    assertCapabilitySchema(descriptor.inputSchema);
    const definition=Object.freeze({id,version:descriptor.version,title:text(descriptor.title,120),description:text(descriptor.description,1000),inputSchema:structuredClone(descriptor.inputSchema)});
    const provider={...descriptor,definition,fingerprint:hash(definition)};
    this.providers.set(id,provider);
    return ()=>{if(this.providers.get(id)===provider)this.providers.delete(id);};
  }
  available(agent,id){const p=this.providers.get(id);return !!p&&p.available?.(agent)!==false;}
  definition(agent,id){const p=this.providers.get(id);return this.available(agent,id)?{...structuredClone(p.definition),fingerprint:p.fingerprint}:null;}
  validate(agent,id,input,fingerprint){const p=this.providers.get(id);if(!this.available(agent,id))fail('BEHAVIOR_UNAVAILABLE');if(fingerprint&&p.fingerprint!==fingerprint)fail('BEHAVIOR_DEFINITION_CHANGED');return validateCapabilityInput(p.definition.inputSchema,input);}
  eventReferences(agent,id,input){
    const p=this.providers.get(id);this.validate(agent,id,input);
    const ids=p.eventsForInput?.(input)??[];
    if(!Array.isArray(ids)||ids.length>16||new Set(ids).size!==ids.length||ids.some(value=>typeof value!=='string'||value.length>64))fail('INVALID_BEHAVIOR_EVENT_REFERENCES');
    if(ids.length&&!agent.factory.pluginEvents?.valid(agent.id,ids))fail('PLUGIN_EVENT_UNAVAILABLE');
    return [...ids];
  }
  opportunities(agent,snapshot){
    const result=[];
    for(const [id,p] of this.providers){
      try{
        if(!this.available(agent,id)||!p.opportunities)continue;
        const rows=p.opportunities(agent,snapshot);
        if(!Array.isArray(rows)||rows.length>8)fail('INVALID_BEHAVIOR_OPPORTUNITIES');
        const accepted=[];
        for(const row of rows){if(!plain(row))fail('INVALID_BEHAVIOR_OPPORTUNITIES');const question=text(row.question,240),input=row.input===undefined?undefined:this.validate(agent,id,row.input);const eventIds=row.eventIds??[];if(!Array.isArray(eventIds)||eventIds.length>16||new Set(eventIds).size!==eventIds.length||eventIds.some(eventId=>!snapshot.events?.some(event=>event.id===eventId&&event.kind==='plugin')))fail('INVALID_BEHAVIOR_EVENT_REFERENCES');accepted.push({kind:'behavior',behaviorId:id,behaviorFingerprint:p.fingerprint,question,...(eventIds.length?{eventIds:[...eventIds]}:{}),...(input===undefined?{}:{behaviorInput:input}),behaviorDefinition:{...p.definition,fingerprint:p.fingerprint}});}
        result.push(...accepted);
      }catch(error){agent.factory.journal.audit(agent.id,'behavior-provider-held',{behaviorId:id,code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'BEHAVIOR_PROVIDER_FAILED'});}
    }
    return result;
  }
  async execute(agent,task,context){
    const c=task.checkpoint,p=this.providers.get(c.behaviorId);this.validate(agent,c.behaviorId,c.plan.input,c.behaviorFingerprint);context.valid();
    const guarded=()=>{context.valid();if(this.providers.get(c.behaviorId)!==p)fail('BEHAVIOR_DEFINITION_CHANGED');this.validate(agent,c.behaviorId,c.plan.input,c.behaviorFingerprint);if(c.pluginEventIds?.length&&!agent.factory.pluginEvents?.valid(agent.id,c.pluginEventIds))fail('PLUGIN_EVENT_UNAVAILABLE');};
    let modelCall=null,modelError=null,closed=false;
    const request=async messages=>{
      if(closed)fail('BEHAVIOR_EXECUTION_CLOSED');guarded();if(!context.request)fail('BEHAVIOR_MODEL_UNAVAILABLE');if(modelCall)fail('CONCURRENT_BEHAVIOR_MODEL_CALL');
      const call=Promise.resolve().then(()=>context.request(messages));modelCall=call;
      try{return await call;}catch(error){modelError=error;throw error;}finally{if(modelCall===call)modelCall=null;}
    };
    let result;
    try{result=await p.execute(agent,structuredClone(c.plan.input),{...context,request,valid:guarded,task:structuredClone(task)});}
    finally{closed=true;if(modelCall)await modelCall.catch(error=>{modelError=error;});}
    if(modelError)throw modelError;
    guarded();
    if(!plain(result)||!['completed','waiting','failed','unknown'].includes(result.status)||typeof result.summary!=='string'||!result.summary.trim()||result.summary.length>1200||Buffer.byteLength(JSON.stringify(result))>32768)fail('INVALID_BEHAVIOR_RESULT');
    return {...result,summary:result.summary.trim(),behaviorId:c.behaviorId,behaviorFingerprint:p.fingerprint,ownerSatisfaction:'unknown'};
  }
}

// Compatibility exports for installed adapters and persisted workflow tests.
export {syncCapabilityBehaviors,behaviorTaskReady} from './capability-behaviors.mjs';
