import fs from 'node:fs/promises';import path from 'node:path';
export const name='human-react-page-example';
export const inject=['humanPages'];
export function apply(ctx){
 if(ctx.humanPages.contractVersion!==2)throw Error('HUMAN_PAGE_CONTRACT_UNSUPPORTED');
 const directory=path.join(process.env.DSH_HOME,'become-human','react-page-example'),file=path.join(directory,'counter.json');let writes=Promise.resolve();
 const read=async()=>{try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(!Number.isSafeInteger(value.count)||value.count<0)throw Error('COUNTER_INVALID');return value.count;}catch(e){if(e.code==='ENOENT')return 0;throw e;}};
 ctx.effect(()=>ctx.humanPages.register('dsh-human-react-page-example','counter',{
  'counter.read':{mode:'read',handle:async(_,call)=>({count:await read(),sessionId:call.sessionId})},
  'counter.add':{mode:'write',handle:(input,call)=>{
    if(input?.amount!==1)throw Error('EXTENSION_COUNTER_INPUT_INVALID');
    const work=writes.catch(()=>{}).then(async()=>{call.signal.throwIfAborted();const count=(await read())+1;await fs.mkdir(directory,{recursive:true});const temp=file+'.'+call.requestId+'.tmp';try{await fs.writeFile(temp,JSON.stringify({count}),{flag:'wx'});call.signal.throwIfAborted();await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}return {count,sessionId:call.sessionId};});writes=work;return work;
  }},
  'sample.error':{mode:'read',handle:async()=>{throw Error('sample internal error');}},
  'sample.slow':{mode:'read',handle:(_,call)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{call.signal.removeEventListener('abort',abort);resolve({ok:true});},20000);const abort=()=>{clearTimeout(timer);reject(Error('aborted'));};call.signal.addEventListener('abort',abort,{once:true});if(call.signal.aborted)abort();})}
 }));
}
