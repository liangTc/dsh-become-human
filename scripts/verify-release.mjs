import fs from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const suites=['memory-continuity','dialogue','behavior-core','attempt-lifecycle','controller-admission','extension-pages','extension-management','extension-registry','worker-request','web-experience'];
const results=[];
for(const suite of suites){
 const r=spawnSync(process.execPath,['--import',pathToFileURL(path.join(root,'scripts/test-dependencies.mjs')).href,path.join(root,'scripts/verify-'+suite+'.mjs')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:suite==='memory-continuity'?600000:120000,env:{...process.env,BH_TEST_DEPENDENCY_ANCHOR:path.join(root,'plugins/become-human-web/manager.mjs'),NODE_PATH:path.join(root,'plugins/become-human-web/node_modules')}});
 process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');results.push({suite,exitCode:r.status,error:r.error?.code});if(r.status!==0)break;
}
console.log(JSON.stringify({releaseRegression:results}));if(results.length!==suites.length||results.some(x=>x.exitCode!==0))process.exitCode=1;
