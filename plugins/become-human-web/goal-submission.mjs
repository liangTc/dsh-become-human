// A retry of an unchanged draft must retain both its key and absolute expiry.
// A changed draft represents a different request; successful callers clear it.
export function prepareGoalSubmission(previous,draft,{now=Date.now(),newId=()=>crypto.randomUUID()}={}){
  const signature=JSON.stringify(draft);
  if(previous?.signature===signature)return previous;
  const {days,...payload}=draft;
  return {signature,payload:{...payload,requestId:newId(),expires:now+days*86400000}};
}
