// A transactional outbox for *local feedback*, never an execution/retry queue.
// Terminal task state is durable before feedback; a crash cannot replay tools.
export function drainActivityFeedback(factory,id,{limit=16,now=Date.now()}={}){
  if(!Number.isInteger(limit)||limit<1||limit>64)throw Error('INVALID_FEEDBACK_LIMIT');
  const j=factory.journal,db=j.db;j.assertAdmitted(id);
  const rows=db.prepare('SELECT * FROM human_activity_feedback WHERE agent=? AND next_at<=? ORDER BY created,task LIMIT ?').all(id,now,limit);
  let completed=0,held=0;
  for(const row of rows){
    try{j.transaction(()=>{
      const task=factory.autonomy.getTask(row.task);
      if(task&&task.agent!==id)throw Error('FEEDBACK_SESSION_MISMATCH');
      if(task&&['completed','failed','cancelled'].includes(task.status)){
        factory.experience?.recordTask(id,task.id);
        factory.goals?.failed(id,task.id);
        factory.cognition?.reflectTask(id,task.id);
      }
      db.prepare('DELETE FROM human_activity_feedback WHERE agent=? AND task=?').run(id,row.task);
    });completed++;}
    catch(error){const code=/^[A-Z_]{3,80}$/.test(error.message)?error.message:'ACTIVITY_FEEDBACK_FAILED',attempts=row.attempts+1;
      db.prepare('UPDATE human_activity_feedback SET attempts=?,code=?,next_at=? WHERE agent=? AND task=?').run(attempts,code,now+Math.min(600000,5000*2**Math.min(7,attempts-1)),id,row.task);
      if(row.code!==code)j.audit(id,'activity-feedback-held',{taskId:row.task,code,executionWillNotRepeat:true});held++;
    }
  }
  return {completed,held,pending:db.prepare('SELECT count(*) n FROM human_activity_feedback WHERE agent=?').get(id).n};
}
