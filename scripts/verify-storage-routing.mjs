import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolveDshManifest} from '../plugins/become-human-web/dsh-launch.mjs';

// Route first-party imports from the source checkout to the actual host under
// test. Packaged plugins normally receive this resolution from DSH startup.
const anchor=pathToFileURL(resolveDshManifest()).href;
const hook=registerHooks({resolve(name,context,next){
  if(name.startsWith('@deepseek-ai/'))return next(name,{...context,parentURL:anchor});
  return next(name,context);
}});
const {Context}=await import('@deepseek-ai/cordis');
const {Session}=await import('@deepseek-ai/dsh-session');
const {GuardedJsonl}=await import('../plugins/become-human/safety.mjs');
const tempRoot=await fs.realpath(os.tmpdir());
const dir=await fs.mkdtemp(path.join(tempRoot,'human-storage-routing-'));
async function open(){
  const ctx=new Context();
  const fiber=await ctx.plugin(GuardedJsonl,{root:path.join(dir,'sessions'),safetyRoot:path.join(dir,'safety'),compression:'none'});
  await ctx.sessionPersistence.ready;
  return {ctx,fiber,storage:ctx.sessionPersistence};
}
let service;
try{
  service=await open();
  const id=crypto.randomUUID(),session=Session.create(id);
  const writer=await service.storage.create(session.header);
  session.append('user/message',{id:crypto.randomUUID(),role:'user',source:{kind:'storage-test'},content:[{type:'text',text:'synthetic'}]},{surfaceOp:'append'});
  for(const event of session.snapshotEvents())service.ctx.emit('session/event',session,event);
  await service.ctx.parallel('session/flush',session);
  await writer.close();
  await service.fiber.dispose();
  service=await open();
  const reader=await service.storage.open(id,'read');
  assert.equal((await reader.read()).events.length,session.snapshotEvents().length);
  assert.ok((await service.storage.list()).some(row=>row.header.id===id));
  await reader.close();
  // The storage service itself must never expose an already-retired body.
  await service.storage.ledger.prepare(crypto.randomUUID(),'retire',{oldId:id,newId:crypto.randomUUID()});
  await service.fiber.dispose();
  service=await open();
  await assert.rejects(()=>service.storage.open(id,'read'),/SESSION_RETIRED/);
  assert.equal(await service.storage.stat(id),undefined);
  assert.ok(!(await service.storage.list()).some(row=>row.header.id===id));
  console.log('Verified native event routing, cold reopen and retired-session guards.');
}finally{
  try{await service?.fiber.dispose();}finally{
    hook.deregister();
    if(path.dirname(await fs.realpath(dir))!==tempRoot)throw Error('UNEXPECTED_TEMP_DIRECTORY');
    await fs.rm(dir,{recursive:true,force:true,maxRetries:4});
  }
}
