const retryableReads=new Set(['behavior-catalog','workflow-catalog']);
const transientCodes=new Set(['WORKER_REQUEST_TIMEOUT','WORKER_CONNECTION_FAILED']);

// Retry only observation requests against the very same worker. A successful
// mutation with a lost response must never be submitted a second time here.
export async function workerRequest({base,cookie,resource,body,sameWorker,fetcher=fetch,timeoutMs=45000,onFailure=()=>{},onRecovered=()=>{}}){
  const retrySafe=resource==='state'&&!body||resource==='read'&&retryableReads.has(body?.kind);
  for(let attempt=0;attempt<(retrySafe?2:1);attempt++){
    if(!sameWorker())throw Error('WORKER_UNAVAILABLE');
    let response,data;
    try{
      const signal=AbortSignal.timeout(timeoutMs);
      try{
        response=await fetcher(base+'/api/become-human/'+resource,{...(body?{method:'POST',body:JSON.stringify(body)}:{}),headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},redirect:'error',signal});
        const raw=await response.text();
        try{data=JSON.parse(raw);}catch{throw Error('WORKER_RESPONSE_INVALID');}
      }catch(error){
        if(signal.aborted)throw Error('WORKER_REQUEST_TIMEOUT');
        if(error instanceof TypeError)throw Error('WORKER_CONNECTION_FAILED');
        throw error;
      }
      if(!response.ok){const error=Error(/^[A-Z][A-Z0-9_]{2,64}$/.test(data?.error??'')?data.error:'WORKER_REQUEST_FAILED');error.status=response.status;throw error;}
      if(!sameWorker())throw Error('WORKER_UNAVAILABLE');
      onRecovered();return data;
    }catch(error){
      const code=/^[A-Z][A-Z0-9_]{2,64}$/.test(error.message??'')?error.message:'WORKER_REQUEST_FAILED';
      onFailure({code,operation:resource.split('?')[0],attempt:attempt+1,...(response?{status:response.status}:{})});
      if(attempt===0&&retrySafe&&transientCodes.has(code)&&sameWorker())continue;
      throw error;
    }
  }
}
