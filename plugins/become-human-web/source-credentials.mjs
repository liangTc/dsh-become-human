import fs from 'node:fs/promises';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {parseCredentialsDocument} from '@deepseek-ai/dsh-credentials-local';

const credentialName=value=>typeof value==='string'&&/^\w+$/.test(value);
const lookupName=value=>process.platform==='win32'?value.toUpperCase():value;

function absoluteDirectory(value){
  if(typeof value!=='string'||!value||value.includes('\0')||!path.isAbsolute(value))throw new Error();
  return path.resolve(value);
}

async function optionalText(file){
  try{return await fs.readFile(file,'utf8');}
  catch(error){if(error?.code==='ENOENT')return undefined;throw error;}
}

async function dotenvValues(directory){
  const text=await optionalText(path.join(directory,'.env'));
  return new Map(Object.entries(text===undefined?{}:parseEnv(text)).map(([name,value])=>[lookupName(name),value]));
}

/**
 * Resolve only the requested credential references for private model discovery
 * and child-process startup. The returned values must never be sent to the
 * browser, logged, or persisted in runtime configuration.
 *
 * This mirrors LocalCredentialProvider's reference precedence without loading
 * an environment into the manager process. Node's parseEnv is the same dotenv
 * parser used by the official DSH launcher.
 */
export async function readSourceCredentialReferences(config,refs){
  try{
    const sourceHome=absoluteDirectory(config?.sourceHome);
    const sourceCwd=absoluteDirectory(config?.sourceCwd??process.cwd());
    if(!Array.isArray(refs)&&!(refs instanceof Set))throw new Error();
    const requested=[...new Set(refs)];
    if(requested.some(ref=>!credentialName(ref)))throw new Error();
    if(!requested.length)return new Map();

    const inherited=new Map(Object.entries(process.env).map(([name,value])=>[lookupName(name),value]));
    const file=path.join(sourceHome,'.credentials.yaml');
    const [credentialText,project,user]=await Promise.all([
      optionalText(file),
      dotenvValues(sourceCwd),
      sourceCwd===sourceHome?Promise.resolve(undefined):dotenvValues(sourceHome),
    ]);
    const managed=credentialText===undefined?new Map():parseCredentialsDocument(credentialText,file).refs;
    const resolved=new Map();
    for(const ref of requested){
      const inheritedValue=config.sourceLaunchEnvironment?.getFrom?config.sourceLaunchEnvironment.getFrom(ref,['process'])?.value:inherited.get(lookupName(ref));
      const managedValue=managed.get(ref);
      // A nonempty inherited secret wins. An empty process value does not
      // shadow the managed store, matching credentials-local.inherited().
      if(typeof inheritedValue==='string'&&inheritedValue.length){resolved.set(ref,inheritedValue);continue;}
      if(typeof managedValue==='string'&&managedValue.length){resolved.set(ref,managedValue);continue;}
      const key=lookupName(ref);
      // getFrom(project-env,user-env) selects the first defined entry before
      // checking whether it is empty: an explicit empty project entry blocks
      // the home fallback, just as it does in the official provider.
      const fallback=project.has(key)?project.get(key):user?.get(key);
      if(typeof fallback==='string'&&fallback.length)resolved.set(ref,fallback);
    }
    if(process.platform==='win32'){
      const folded=new Map();
      for(const [ref,value] of resolved){
        const key=lookupName(ref);
        if(folded.has(key)&&folded.get(key)!==value)throw new Error();
        folded.set(key,value);
      }
    }
    return resolved;
  }catch{
    // Upstream parse errors can contain document text, paths, or references.
    // Keep this boundary opaque and never attach the original error as cause.
    throw new Error('SOURCE_CREDENTIALS_INVALID');
  }
}
