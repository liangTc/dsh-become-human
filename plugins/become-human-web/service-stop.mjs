import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const home=path.resolve(process.argv[2]??'');if(!process.argv[2])throw Error('DATA_HOME_REQUIRED');
try{
  const record=JSON.parse(await fs.readFile(path.join(home,'.human-service-process.json'),'utf8'));
  const knownEntry=path.join(import.meta.dirname,'service-host.mjs'),normalize=value=>String(value??'').replaceAll('\\','/').toLowerCase();
  if(record.home!==home||normalize(record.entry)!==normalize(knownEntry)||!Number.isSafeInteger(record.pid)||record.pid<=0||record.pid===process.pid)throw Error('SERVICE_IDENTITY_MISMATCH');
  const identity=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`$serviceProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}' -ErrorAction Stop; [pscustomobject]@{CommandLine=$serviceProcess.CommandLine;StartedAt=$serviceProcess.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:10000}));
  const started=Date.parse(identity?.StartedAt),recorded=Date.parse(record.startedAt);
  if(!normalize(identity?.CommandLine).includes(normalize(knownEntry))||!normalize(identity.CommandLine).includes(normalize(home))||!Number.isFinite(started)||!Number.isFinite(recorded)||Math.abs(started-recorded)>10000)throw Error('SERVICE_IDENTITY_MISMATCH');
  const link=JSON.parse(await fs.readFile(path.join(home,'become-human-manager/launch.json'),'utf8')),login=new URL(link.url);
  if(login.hostname!=='127.0.0.1')throw Error('INVALID_SERVICE_LOGIN');const base=login.origin;login.pathname='/';
  const response=await fetch(login,{redirect:'manual',signal:AbortSignal.timeout(5000)});if(response.status!==303)throw Error('SERVICE_LOGIN_FAILED');
  const cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const currentResponse=await fetch(base+'/api/become-human/state',{headers:{cookie},signal:AbortSignal.timeout(5000)});if(!currentResponse.ok)throw Error('SERVICE_IDENTITY_MISMATCH');const current=await currentResponse.json();if(current.manager?.health?.managerPid!==record.pid)throw Error('SERVICE_IDENTITY_MISMATCH');
  const stopped=await fetch(base+'/api/become-human/control',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({op:'runtime-stop'}),signal:AbortSignal.timeout(15000)});if(!stopped.ok)throw Error('WORKER_STOP_FAILED');
  const stoppedState=await stopped.json();if(stoppedState.manager?.health?.managerPid!==record.pid)throw Error('SERVICE_IDENTITY_MISMATCH');
  // Keep a process handle while checking the captured start time and terminating,
  // so a later process which reuses the numeric PID cannot become the target.
  execFileSync('powershell.exe',['-NoProfile','-Command',`$serviceTarget=Get-Process -Id ${record.pid} -ErrorAction Stop; [void]$serviceTarget.Handle; $expected=[DateTime]::Parse('${new Date(started).toISOString()}').ToUniversalTime(); if([Math]::Abs(($serviceTarget.StartTime.ToUniversalTime()-$expected).TotalMilliseconds) -ge 1){throw 'SERVICE_IDENTITY_MISMATCH'}; $serviceTarget.Kill(); if(-not $serviceTarget.WaitForExit(5000)){throw 'SERVICE_STOP_TIMEOUT'}`],{encoding:'utf8',windowsHide:true,timeout:10000});console.log(JSON.stringify({stopped:true,pid:record.pid,workerStoppedFirst:true}));
}catch(e){console.error(JSON.stringify({ok:false,code:/^[A-Z_]{3,80}$/.test(e.message)?e.message:'SERVICE_STOP_FAILED'}));process.exitCode=1;}
