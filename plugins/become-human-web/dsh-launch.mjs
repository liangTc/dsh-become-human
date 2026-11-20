import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {supportedHostVersion} from './runtime/dsh-compatibility.mjs';

// The packaged Desktop host runs inside Electron in Node mode. Its signed DSH
// installation lives outside the plugin's profile dependency tree.
function desktopInstallation(){
  if(!process.versions.electron||!process.resourcesPath)return null;
  const anchor=path.join(process.resourcesPath,'app.asar','dsh','package.json');
  return fs.existsSync(anchor)?anchor:null;
}

export function resolveDshManifest(){
  const owner=createRequire(desktopInstallation()??import.meta.url);
  return owner.resolve('@deepseek-ai/dsh/package.json');
}

export function resolveDshEntry(manifest=resolveDshManifest()){
  return path.resolve(path.dirname(manifest),JSON.parse(fs.readFileSync(manifest,'utf8')).bin.dsh);
}

// A logon service starts before DSH has installed its module resolution hooks.
// Keep the last known Web installation so it can use the same CLI as its host.
export async function rememberWebServiceHost(managerDir,profile,manifest){
  if(!/^[\w-]+$/.test(profile)||profile==='desktop'||!path.isAbsolute(manifest))return;
  const file=path.join(managerDir,'service-cli-'+profile+'.json'),text=JSON.stringify({manifest});
  const existing=await fs.promises.readFile(file,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
  if(existing===text)return;
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.promises.writeFile(tmp,text,{flag:'wx'});await fs.promises.rename(tmp,file);}
  finally{await fs.promises.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

export function webServiceEntry(home,profile){
  const file=path.join(home,'become-human-manager','service-cli-'+profile+'.json');
  const saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  let manifest=saved?.manifest;
  if(!manifest||!path.isAbsolute(manifest)||!fs.existsSync(manifest))manifest=resolveDshManifest();
  const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
  if(pkg.name!=='@deepseek-ai/dsh'||!supportedHostVersion('web',pkg.version)||pkg.bin?.dsh!=='lib/bin.js')throw Error('SERVICE_DSH_INSTALLATION_INVALID');
  return path.join(path.dirname(manifest),pkg.bin.dsh);
}

export function nodeChild(script,args,env){
  const electron=Boolean(process.versions.electron);
  return {
    args:[...(electron?['--expose-internals']:[]),script,...args],
    env:electron?{...env,ELECTRON_RUN_AS_NODE:'1'}:env
  };
}

// Desktop ships pnpm as a module, not necessarily a command on PATH. Use the
// same executable and launcher environment as its bundled dsh command.
export async function runProfileCli(entry){
  const {runCli}=await import(pathToFileURL(entry).href);
  if(!desktopInstallation())return runCli();
  const support=path.join(process.resourcesPath,'runtime');
  return runCli({packageManager:{
    command:process.execPath,
    args:['--expose-internals',path.join(support,'primary-runtime','dependencies','pnpm','bin','pnpm.mjs')],
    env:{
      ELECTRON_RUN_AS_NODE:'1',
      DSH_DESKTOP_NODE_EXECUTABLE:process.execPath,
      PATH:[path.join(support,'bin'),process.env.PATH].filter(Boolean).join(path.delimiter)
    }
  }});
}
