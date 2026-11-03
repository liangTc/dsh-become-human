// One interpretation of durable execution status, separate from satisfaction
// and inferred personality. Keep legacy task status and receipt hashes intact.
export function activityOutcome(task){
  const result=task.checkpoint?.behaviorResult;
  const status=result?.status==='unknown'?'unknown':task.status;
  const confirmed=['completed','failed','cancelled'].includes(status)&&
    (status==='completed'||!!result&&result.status!=='waiting');
  return {status,executionConfirmed:confirmed,growthEvidence:confirmed,
    ownerSatisfaction:'unknown',causalImprovement:'unverified',
    reason:status==='unknown'?'outcome-unknown':confirmed?'recorded-execution':'no-confirmed-execution'};
}
