// Serialized with all manager mutations and IM controls. Only configuration
// operations may use this path; it cannot resume an unrelated paused run.
export const configurationOperations=new Set(['profile-save','execution-save','data-save','autonomy-configure','usage-prices-save','relationship-configure','persona-development-configure','memory-lifecycle-configure','work-observation-configure','skill-save','skill-toggle']);
export async function saveConfiguration({runtime,remote,input}){
  const command=input.command;
  if(!command||!configurationOperations.has(command.op))throw Error('INVALID_CONFIGURATION_OPERATION');
  return remote.queueControl(async()=>{
    if(remote.maintenance)throw Error('EXTENSION_OPERATION_BUSY');
    const before=await runtime.state();
    if(!input.sessionId||before.sessionId!==input.sessionId)throw Error('STALE_SESSION');
    if(command.expectedRevision!==undefined&&command.expectedRevision!==before.management.revision)throw Error('STALE_CONFIGURATION');
    // Do not interrupt active work just to change a preference.
    if(before.agentBusy)throw Error('AGENT_BUSY');
    const resume=before.desired==='running'&&before.driveMode==='continuous';
    if(before.desired==='running'&&!resume)throw Error('PAUSE_REQUIRED');
    remote.maintenance=true;
    try{
      if(resume)await runtime.control({op:'pause',sessionId:before.sessionId});
      const paused=await runtime.state();
      if(paused.desired!=='paused'||paused.agentBusy)throw Error('PAUSE_REQUIRED');
      await runtime.control({...command,sessionId:before.sessionId});
      const saved=await runtime.state();
      if(resume){
        if(saved.sessionId!==before.sessionId||saved.cancelEpoch!==paused.cancelEpoch||saved.desired!=='paused'||saved.autonomy?.paused!==before.autonomy?.paused)throw Error('CONFIGURATION_SAVED_NOT_RESUMED');
        await runtime.control({op:'start',sessionId:before.sessionId,expectedEpoch:saved.cancelEpoch});
      }
      return await runtime.state();
    }catch(error){
      // An unsuccessful or uncertain mutation is not a reason to restart work.
      if(resume)remote.blockWake('configuration-save-failed');
      throw error;
    }finally{remote.maintenance=false;}
  });
}
