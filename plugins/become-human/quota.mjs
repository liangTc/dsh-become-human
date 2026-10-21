const DAY=86400000;
export function quotaWindow(policy,now){
  let start,end;
  if(policy.budgetWindow==='rolling-day'){start=now-DAY;end=null;}
  else{const offset=policy.budgetWindow==='local-day'?(policy.timeZoneOffsetMinutes??480)*60000:0;start=Math.floor((now+offset)/DAY)*DAY-offset;end=start+DAY;}
  if(policy.quotaTransitionUntil>now)start=Math.min(start,policy.quotaTransitionStart);
  return {start,end};
}
export function quotaView(ledger,agent,policy,now){
  const {start,end}=quotaWindow(policy,now),entries=ledger.autonomyEntries(agent,start),grants=ledger.autonomyGrants(agent,now),on=policy.quotaEnabled!==false;
  const roundIds=[...new Set(entries.map(e=>e.roundId??'legacy:'+e.rid))];
  return {now,windowStart:start,windowEnd:end??now+DAY,resetAt:end,budgetWindow:policy.budgetWindow??'utc-day',quotaEnabled:on,
    tokenLimit:on&&policy.tokenQuotaEnabled!==false?policy.tokenLimit+grants.reduce((n,g)=>n+g.tokens,0):null,
    requestLimit:on&&policy.requestQuotaEnabled!==false?policy.requestLimit+grants.reduce((n,g)=>n+g.requests,0):null,
    roundLimit:on&&policy.roundQuotaEnabled===true?(policy.roundLimit??24)+grants.reduce((n,g)=>n+(g.rounds??0),0):null,
    reservedTokens:entries.reduce((n,e)=>n+e.amount,0),requests:entries.length,rounds:roundIds.length,roundIds,legacyRoundEstimate:entries.filter(e=>!e.roundId).length,grants};
}
export function quotaAllows(view,{tokens=0,requests=0,roundId}){
  return (view.tokenLimit===null||view.reservedTokens+tokens<=view.tokenLimit)&&(view.requestLimit===null||view.requests+requests<=view.requestLimit)&&(view.roundLimit===null||view.roundIds.includes(roundId)||view.rounds<view.roundLimit);
}
export function roundDuration(ledger,agent,roundId){
  const ids=ledger.autonomyAgents(agent),segments=new Map();
  for(const row of ledger.rows){if(!['autonomy-segment-start','autonomy-segment-end'].includes(row.kind))continue;const d=JSON.parse(row.data);if(!ids.has(d.agent)||d.roundId!==roundId)continue;if(row.kind==='autonomy-segment-start')segments.set(d.id,{...d,used:0});else if(segments.has(d.id))segments.get(d.id).used=d.used;}
  return [...segments.values()].reduce((n,s)=>n+s.used,0);
}
