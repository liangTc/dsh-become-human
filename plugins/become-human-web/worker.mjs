import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const req=createRequire(process.env.BH_DSH_ENTRY);
const {parseCredentialsDocument}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-credentials-local')).href);
const manifest=JSON.parse(await fs.readFile(path.join(process.env.BH_RUNTIME_HOME,'runtime-selection.json'),'utf8'));
if(!manifest.apiKeyEnv||!/^\w+$/.test(manifest.apiKeyEnv))throw new Error('INVALID_CREDENTIAL_REFERENCE');
const credentialFile=path.join(process.env.BH_SOURCE_HOME,'.credentials.yaml');
if(!process.env[manifest.apiKeyEnv]){
  const credentials=parseCredentialsDocument(await fs.readFile(credentialFile,'utf8'),credentialFile);
  const value=credentials.refs.get(manifest.apiKeyEnv);if(!value)throw new Error('MODEL_CREDENTIAL_MISSING');process.env[manifest.apiKeyEnv]=value;
}
const additionalRefs=(manifest.apiKeyEnvs??[]).filter(ref=>ref!==manifest.apiKeyEnv&&!process.env[ref]);
if(additionalRefs.length){const document=parseCredentialsDocument(await fs.readFile(credentialFile,'utf8'),credentialFile);for(const ref of additionalRefs){if(!/^\w+$/.test(ref))throw new Error('INVALID_CREDENTIAL_REFERENCE');const value=document.refs.get(ref);if(value)process.env[ref]=value;}}
process.env.DSH_HOME=process.env.BH_RUNTIME_HOME;process.env.DSH_TELEMETRY_ENABLED='false';
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])if(process.env[key]?.includes('127.0.0.1:9'))delete process.env[key];
const original=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>original(String(chunk).replace(/([?&]token=)[^\s"'<>]+/g,'$1[REDACTED]'),...args);
process.argv=[process.execPath,'dsh','--profile',process.env.BH_RUNTIME_PROFILE,'--no-open','--port',process.env.BH_RUNTIME_PORT];
const {runCli}=await import(pathToFileURL(process.env.BH_DSH_ENTRY).href);await runCli();
