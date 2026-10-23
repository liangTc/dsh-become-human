import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const manifest=JSON.parse(await fs.readFile(path.join(process.env.BH_RUNTIME_HOME,'runtime-selection.json'),'utf8'));
if(!manifest.apiKeyEnv||!/^\w+$/.test(manifest.apiKeyEnv))throw new Error('INVALID_CREDENTIAL_REFERENCE');
if(!Array.isArray(manifest.apiKeyEnvs)||manifest.apiKeyEnvs.some(ref=>typeof ref!=='string'||!/^\w+$/.test(ref)))throw new Error('INVALID_CREDENTIAL_REFERENCE');
// The manager resolves source provenance and supplies only referenced values
// in this child's environment. Do not reinterpret its already flattened env.
if(!process.env[manifest.apiKeyEnv])throw new Error('MODEL_CREDENTIAL_MISSING');
process.env.DSH_HOME=process.env.BH_RUNTIME_HOME;process.env.DSH_TELEMETRY_ENABLED='false';
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])if(process.env[key]?.includes('127.0.0.1:9'))delete process.env[key];
const original=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>original(String(chunk).replace(/([?&]token=)[^\s"'<>]+/g,'$1[REDACTED]'),...args);
process.argv=[process.execPath,'dsh','--profile',process.env.BH_RUNTIME_PROFILE,'--no-open','--port',process.env.BH_RUNTIME_PORT];
const {runCli}=await import(pathToFileURL(process.env.BH_DSH_ENTRY).href);await runCli();
