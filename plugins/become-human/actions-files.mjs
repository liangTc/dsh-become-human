import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const MAX_REPORT_BYTES=65536;
export const artifactHash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const fail=code=>{throw new Error(code);};
const comparable=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
export function actionPaths(root,agent,id){
  if(!uuid.test(agent)||!uuid.test(id))fail('INVALID_ACTION_ID');
  const directory=path.join(root,agent);return {root,directory,path:path.join(directory,id+'.md'),stage:path.join(directory,id+'.pending')};
}
function ancestry(target){const absolute=path.resolve(target),base=path.parse(absolute).root;let current=base;return [base,...path.relative(base,absolute).split(path.sep).filter(Boolean).map(part=>(current=path.join(current,part)))];}
export function checkedActionPath(root,target,{missing=false}={}){
  const relative=path.relative(root,target);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('ACTION_PATH_OUTSIDE_ROOT');
  for(const current of ancestry(target)){
    let stat;try{stat=fs.lstatSync(current);}catch(error){if(missing&&error.code==='ENOENT')return target;throw error;}
    if(stat.isSymbolicLink()||comparable(fs.realpathSync.native(current))!==comparable(current))fail('ACTION_LINKED_PATH');
    if(current!==target&&!stat.isDirectory())fail('ACTION_INVALID_DIRECTORY');
  }return target;
}
export async function ensureActionDirectory(paths){
  for(const current of ancestry(paths.directory)){
    try{const stat=await fsp.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||comparable(await fsp.realpath(current))!==comparable(current))fail('ACTION_LINKED_PATH');}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(current),stat=await fsp.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||comparable(await fsp.realpath(parent))!==comparable(parent))fail('ACTION_LINKED_PATH');try{await fsp.mkdir(current,{mode:0o700});}catch(created){if(created.code!=='EEXIST')throw created;}const next=await fsp.lstat(current);if(!next.isDirectory()||next.isSymbolicLink()||comparable(await fsp.realpath(current))!==comparable(current))fail('ACTION_LINKED_PATH');}
  }
  checkedActionPath(paths.root,paths.path,{missing:true});checkedActionPath(paths.root,paths.stage,{missing:true});
}
export function sameManagedPair(paths){
  try{checkedActionPath(paths.root,paths.path);checkedActionPath(paths.root,paths.stage);const a=fs.lstatSync(paths.path),b=fs.lstatSync(paths.stage);return a.isFile()&&b.isFile()&&!a.isSymbolicLink()&&!b.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino&&a.nlink===2&&b.nlink===2;}catch{return false;}
}
export function readActionFile(paths,{stage=false,allowPair=false}={}){
  const file=stage?paths.stage:paths.path;let fd;
  try{
    checkedActionPath(paths.root,file);const stat=fs.lstatSync(file),paired=allowPair&&sameManagedPair(paths);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1&&!paired)fail('ACTION_LINKED_ARTIFACT');if(stat.size>MAX_REPORT_BYTES)fail('ACTION_ARTIFACT_CONFLICT');
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const opened=fs.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||!opened.isFile())fail('ACTION_ARTIFACT_CONFLICT');
    const buffer=Buffer.alloc(MAX_REPORT_BYTES+1);let size=0;while(size<buffer.length){const count=fs.readSync(fd,buffer,size,buffer.length-size,size);if(!count)break;size+=count;}
    const end=fs.fstatSync(fd);checkedActionPath(paths.root,file);const pathStat=fs.lstatSync(file);if(size>MAX_REPORT_BYTES||end.size!==size||end.ino!==pathStat.ino||end.dev!==pathStat.dev||end.nlink!==1&&!paired)fail('ACTION_ARTIFACT_CONFLICT');
    const bytes=buffer.subarray(0,size);return {buffer:bytes,bytes:size,digest:artifactHash(bytes),stat:end};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function publishActionFile(paths){
  checkedActionPath(paths.root,paths.stage);checkedActionPath(paths.root,paths.path,{missing:true});fs.linkSync(paths.stage,paths.path);
}
export function cleanupActionStage(paths){
  if(!sameManagedPair(paths))return false;fs.unlinkSync(paths.stage);return true;
}
