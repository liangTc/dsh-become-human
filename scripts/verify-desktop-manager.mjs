// Mount both management plugins with one synthetic DSH_HOME. The caller owns
// the transport and the sample profile, so no real IM or model is dispatched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {apply,managerStoreHome} from '../plugins/become-human-web/manager.mjs';
import {resolveDshManifest,resolveDshEntry,webServiceEntry} from '../plugins/become-human-web/dsh-launch.mjs';

const temp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'human-manager-profiles-'));
const home=path.join(temp,'home');
const closed=[];
try{
 const desktopAnchor=path.join(temp,'desktop-install','package.json');
 await fs.mkdir(path.dirname(desktopAnchor),{recursive:true});
 await fs.writeFile(desktopAnchor,JSON.stringify({name:'@deepseek-ai/dsh',version:'0.2.2-rc.3'}));
 async function mount(name){
  const routes=new Map(),im=[];
  const dir=name==='desktop'?path.join(temp,'desktop-project'):path.join(home,'profiles',name);
  await fs.mkdir(dir,{recursive:true});
  const ctx={
   profileContext:{name,dir,home,installAnchor:name==='desktop'?desktopAnchor:resolveDshManifest()},
   connection:{fetch:{register(route){routes.set(route.path,route);}},authenticatedUrl:url=>url},
   webServer:{register(){},port:0},get(){},provide(){},
   plugin(_plugin,options){im.push(options.dshHome);},effect(factory){closed.push(factory());},
  };
  await apply(ctx,{});
  const state=await (await routes.get('/api/become-human/state').fetch()).json();
  return {setup:state.setup,im:im[0],root:path.join(managerStoreHome(home,name),'become-human-manager')};
 }
 const web=await mount('web'),desktop=await mount('desktop');
 assert.equal(web.root,path.join(home,'become-human-manager'));
 for(const [profile,version,host] of [['web','0.2.0-rc.2',web],['desktop','0.2.2-rc.3',desktop]]){
  assert.equal(host.setup.environment.sourceProfile,profile);
  assert.equal(host.setup.environment.dsh,version);
  assert.equal(host.setup.environment.supported,true);
  assert.equal(host.setup.required,true);assert.equal(host.im,path.join(host.root,'im-home'));
  await fs.access(path.join(host.root,'remote.sqlite'));
  await fs.access(path.join(path.dirname(host.root),'.human-running.lock'));
 }
 assert.notEqual(web.root,desktop.root);
 await fs.access(path.join(web.root,'launch.json'));
 assert.equal(webServiceEntry(home,'web'),resolveDshEntry());
 await assert.rejects(fs.access(path.join(desktop.root,'launch.json')),{code:'ENOENT'});
 console.log('Web rc.2 and Desktop rc.3 setup, routes, data homes, leases and IM state passed under a shared synthetic DSH_HOME.');
}finally{
 for(const close of closed.reverse())await close();
 await fs.rm(temp,{recursive:true,force:true});
}
