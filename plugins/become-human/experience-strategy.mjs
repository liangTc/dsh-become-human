import {createHash,randomUUID} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const strategyBasis=row=>hash({id:row.id,data:row.data});
const invalid=()=>{throw Object.assign(Error('INVALID_BEHAVIOR_SELECTION'),{validationDiagnostic:{field:'strategyUses',reason:'invalid-or-unavailable-reference'}});};
const secret=value=>/(?:sk-[a-z0-9]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu.test(value);
export class ExperienceStrategies {
  constructor(store){
    this.store=store;this.db=store.db;this.journal=store.journal;
    this.db.exec(`CREATE TABLE IF NOT EXISTS human_strategy_use(id TEXT PRIMARY KEY,agent TEXT NOT NULL,task TEXT NOT NULL,round_id TEXT NOT NULL,reflection TEXT NOT NULL,basis TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(agent,task,round_id,reflection));
      CREATE INDEX IF NOT EXISTS human_strategy_use_reflection ON human_strategy_use(agent,reflection,created);`);
  }
  validate(agent,task,uses=[]){
    if(!Array.isArray(uses)||uses.length>3||new Set(uses.map(u=>u?.id)).size!==uses.length)invalid();
    return uses.map(use=>{
      if(!use||Object.getPrototypeOf(use)!==Object.prototype||Object.keys(use).some(k=>!['id','basis','application'].includes(k))||typeof use.application!=='string'||!use.application.trim()||use.application.length>400||secret(use.application))invalid();
      const offered=task.checkpoint.strategyCandidates?.find(row=>row.id===use.id&&row.basis===use.basis),row=this.store.reflection(agent,use.id);
      if(!offered||!row||strategyBasis(row)!==use.basis)invalid();
      return {id:use.id,basis:use.basis,application:use.application.trim()};
    });
  }
  bind(agent,task,uses){
    this.journal.assertAdmitted(agent);const valid=this.validate(agent,task,uses),round=task.checkpoint.roundId??task.id,now=this.store.clock();
    for(const use of valid){
      const old=this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? AND task=? AND round_id=? AND reflection=?').get(agent,task.id,round,use.id);
      if(old){if(old.basis!==use.basis||JSON.parse(old.data).application!==use.application)throw Error('STRATEGY_USE_CONFLICT');continue;}
      const data={application:use.application,declaredBy:'selection-model',deliveredAttempts:[],outcome:null,causalEffect:'unverified',ownerSatisfaction:'unknown'};
      this.db.prepare('INSERT INTO human_strategy_use VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),agent,task.id,round,use.id,use.basis,JSON.stringify(data),now,now);
      this.journal.audit(agent,'strategy-use-declared',{taskId:task.id,reflectionId:use.id,roundId:round});
    }
  }
  forTask(agent,task){
    const uses=task?.checkpoint?.strategyUses??[];
    if(!uses.length)return [];
    try{return this.validate(agent,task,uses).map(use=>{const row=this.store.reflection(agent,use.id);return {...use,lesson:row.data.lesson,nextApproach:row.data.nextApproach,inference:true,authorityChanged:false};});}
    catch{throw Error('STRATEGY_EVIDENCE_CHANGED');}
  }
  delivered(agent,task,attemptId){
    const uses=this.forTask(agent,task),round=task.checkpoint.roundId??task.id;
    for(const use of uses){const row=this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? AND task=? AND round_id=? AND reflection=?').get(agent,task.id,round,use.id);if(!row)throw Error('STRATEGY_USE_NOT_BOUND');const data=JSON.parse(row.data);if(data.deliveredAttempts.includes(attemptId))continue;data.deliveredAttempts.push(attemptId);this.db.prepare('UPDATE human_strategy_use SET data=?,updated=? WHERE id=?').run(JSON.stringify(data),this.store.clock(),row.id);}
  }
  settle(agent,task,experience){
    const round=task.checkpoint.roundId??task.id;
    for(const row of this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? AND task=? AND round_id=?').all(agent,task.id,round)){
      const data=JSON.parse(row.data),outcome={status:task.checkpoint.behaviorResult?.status==='unknown'?'unknown':task.status,experienceId:experience.id,experienceBasis:experience.basis,development:experience.data.development,eligibleForGrowth:experience.data.growthEligible===true};
      if(hash(data.outcome)===hash(outcome))continue;data.outcome=outcome;this.db.prepare('UPDATE human_strategy_use SET data=?,updated=? WHERE id=?').run(JSON.stringify(data),this.store.clock(),row.id);
      this.journal.audit(agent,'strategy-use-outcome',{taskId:task.id,reflectionId:row.reflection,status:outcome.status,development:outcome.development,causalEffect:'unverified'});
    }
  }
  rows(agent,{reflectionId,limit=20}={}){
    this.journal.assertAdmitted(agent);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('INVALID_STRATEGY_QUERY');
    const rows=reflectionId?this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? AND reflection=? ORDER BY created DESC,id DESC LIMIT ?').all(agent,reflectionId,limit):this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? ORDER BY created DESC,id DESC LIMIT ?').all(agent,limit);
    return rows.map(row=>this.project(agent,row));
  }
  project(agent,row){const reflection=this.store.reflection(agent,row.reflection),data=JSON.parse(row.data),experience=data.outcome?this.store.get(agent,data.outcome.experienceId):null;
      const valid=!!reflection&&strategyBasis(reflection)===row.basis&&(!data.outcome||this.store.valid(agent,experience,{includeDevelopment:true})&&experience.basis===data.outcome.experienceBasis);
      return valid?{...row,data,valid:true}:{id:row.id,task:row.task,reflection:row.reflection,created:row.created,valid:false,redacted:true};
  }
  export(agent){this.journal.assertAdmitted(agent);return this.db.prepare('SELECT * FROM human_strategy_use WHERE agent=? ORDER BY created,id').all(agent).map(row=>this.project(agent,row));}
  summary(agent,reflectionId){
    const rows=this.rows(agent,{reflectionId,limit:100}).filter(r=>r.valid),counts={declared:rows.length,providedToExecutor:0,completed:0,failed:0,cancelled:0,unknown:0,developmentExcluded:0};
    for(const row of rows){if(row.data.outcome?.development){counts.developmentExcluded++;continue;}if(row.data.deliveredAttempts.length)counts.providedToExecutor++;const status=row.data.outcome?.status;if(['completed','failed','cancelled','unknown'].includes(status))counts[status]++;}
    return {...counts,scope:'valid-applications-among-latest-100-records',causalEffect:'unverified',ownerSatisfaction:'unknown'};
  }
}
export function strategyRequest(messages,uses){
  if(!uses.length)return messages;
  const out=[...messages,{role:'user',content:[{type:'text',text:JSON.stringify({kind:'runtime-strategy-context',origin:'agent-inference-not-owner-instruction',strategies:uses,scope:'These are provisional methods the selection model proposed. Apply only where compatible with the current task, facts and permissions. Never change fixed input, retry permission or claim effectiveness merely because a task completed.'})}]}];
  for(const key of ['contextReport','memoryAccess'])if(messages[key])Object.defineProperty(out,key,{value:key==='contextReport'?{...messages[key],strategyApplicationCount:uses.length,strategyContextBytes:Buffer.byteLength(JSON.stringify(out.at(-1)))}:messages[key],enumerable:false});
  return out;
}
