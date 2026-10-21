import {randomUUID} from 'node:crypto';
const pending=new Map();let installed=false;
function install(){
  if(installed)return;installed=true;
  process.on('message',message=>{if(message?.kind!=='human-capability-result')return;const call=pending.get(message.id);if(!call)return;pending.delete(message.id);call.cleanup();if(message.error)call.reject(Object.assign(new Error(message.error),{code:message.error}));else call.resolve(message.result);});
  process.on('disconnect',()=>{for(const call of pending.values()){call.cleanup();call.reject(new Error('CAPABILITY_BRIDGE_DISCONNECTED'));}pending.clear();});
}
export function parentCapabilityRequest(operation,input,{signal,context={}}={}){
  install();if(!process.connected||typeof process.send!=='function')return Promise.reject(new Error('CAPABILITY_BRIDGE_UNAVAILABLE'));
  if(pending.size>=4||Buffer.byteLength(JSON.stringify({operation,input,context}))>65536)return Promise.reject(new Error('CAPABILITY_BRIDGE_REQUEST_LIMIT'));
  signal?.throwIfAborted();const id=randomUUID();
  return new Promise((resolve,reject)=>{
    const aborted=()=>{if(!pending.delete(id))return;cleanup();try{process.send({kind:'human-capability-cancel',id});}catch{}reject(Object.assign(new Error('CAPABILITY_CANCELLED'),{code:'CAPABILITY_CANCELLED'}));};
    const timer=setTimeout(()=>{if(!pending.delete(id))return;cleanup();try{process.send({kind:'human-capability-cancel',id});}catch{}reject(new Error('CAPABILITY_BRIDGE_TIMEOUT'));},125000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);};
    pending.set(id,{resolve,reject,cleanup});signal?.addEventListener('abort',aborted,{once:true});
    process.send({kind:'human-capability-request',id,operation,input,context},error=>{if(error&&pending.delete(id)){cleanup();reject(new Error('CAPABILITY_BRIDGE_UNAVAILABLE'));}});
  });
}
