import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {acquireRunningLock,releaseRunningLock} from './operations-log.mjs';
const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--home','--profile','--port'].includes(process.argv[i])||!process.argv[i+1])throw Error('INVALID_SERVICE_ARGUMENTS');options[process.argv[i].slice(2)]=process.argv[i+1];}
if(!options.home||!path.isAbsolute(options.home)||!fs.existsSync(options.home)||!/^[a-zA-Z0-9_-]+$/.test(options.profile??'web')||!/^[0-9]{4,5}$/.test(options.port??'3090')||Number(options.port??3090)>65535)throw Error('INVALID_SERVICE_CONFIGURATION');
process.env.DSH_HOME=path.resolve(options.home);process.env.DSH_TELEMETRY_ENABLED='false';
if(fs.existsSync(path.join(process.env.DSH_HOME,'.human-offline.lock')))throw Error('OFFLINE_STORE_LOCKED');
const hostLease=acquireRunningLock(process.env.DSH_HOME);
process.env.BH_SERVICE_MANAGER_LOCK_HOME=process.env.DSH_HOME;process.env.BH_SERVICE_MANAGER_LOCK_NONCE=hostLease.nonce;
const processRecord=path.join(process.env.DSH_HOME,'.human-service-process.json');
const hostStartedAt=new Date().toISOString();let recorded=false;
process.on('exit',()=>{try{const record=JSON.parse(fs.readFileSync(processRecord,'utf8'));if(record.pid===process.pid)fs.unlinkSync(processRecord);}catch{}try{releaseRunningLock(hostLease);}catch{}});
for(const stream of [process.stdout,process.stderr]){const write=stream.write.bind(stream);stream.write=(chunk,...rest)=>{const text=String(chunk).replace(/([?&]token=)[^\s"'<>]+/g,'$1[REDACTED]');if(!recorded&&text.includes('dsh web:')){const running=JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME,'.human-running.lock'),'utf8'));if(running.pid!==process.pid||fs.existsSync(path.join(process.env.DSH_HOME,'.human-offline.lock')))throw Error('SERVICE_RUNNING_LOCK_MISSING');fs.writeFileSync(processRecord,JSON.stringify({pid:process.pid,home:process.env.DSH_HOME,entry:import.meta.filename,startedAt:hostStartedAt}));recorded=true;}return write(text,...rest);};}
const require=createRequire(import.meta.url),manifest=require.resolve('@deepseek-ai/dsh/package.json'),entry=path.join(path.dirname(manifest),JSON.parse(fs.readFileSync(manifest,'utf8')).bin.dsh);
process.argv=[process.execPath,'dsh','--profile',options.profile??'web','--no-open','--port',options.port??'3090'];
try{const {runCli}=await import(pathToFileURL(entry).href);await runCli();}catch(e){console.error(/^[A-Z_]{3,80}$/.test(e?.message??'')?e.message:'SERVICE_BOOT_FAILED');process.exitCode=1;}
