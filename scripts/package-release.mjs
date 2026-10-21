import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,digest,checkPublicText,version} from './release-files.mjs';
const directory=path.join(root,'plugins/become-human-web'),releaseVersion=await version(),destination=path.join(root,'dist','packages');
await fs.mkdir(destination,{recursive:true});
for(const file of ['client.js','im-client.js','im/lib/index.js','runtime/index.mjs','runtime-bundle/package.json','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md'])await fs.access(path.join(directory,file));
const runtime=JSON.parse(await fs.readFile(path.join(directory,'runtime-bundle/package.json'),'utf8'));if(runtime.version!==releaseVersion)throw Error('BUILD_FIRST: runtime version differs');
const npmExec=process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
const run=args=>{const result=spawnSync(process.execPath,[npmExec,...args],{cwd:directory,encoding:'utf8',windowsHide:true,timeout:120000});if(result.status!==0)throw Error(result.stderr?.slice(-2000)||'NPM_PACK_FAILED');return JSON.parse(result.stdout)[0];};
const preview=run(['pack','--ignore-scripts','--dry-run','--json']);
for(const file of preview.files){if(/(?:node_modules|\.dsh-verify|\.manager-test|\.web-test|whatsapp|libsignal|baileys)/i.test(file.path))throw Error('PACKAGE_BOUNDARY_REVIEW_REQUIRED:'+file.path);checkPublicText(file.path,await fs.readFile(path.join(directory,file.path)));}
for(const file of ['client.js','im-client.js','im/lib/index.js','runtime/vendor/schedule-rules.mjs']){const body=await fs.readFile(path.join(directory,file),'utf8');if(/SessionCipher|Bad MAC|No session record|whatsapp-rust-bridge/.test(body))throw Error('EXCLUDED_TRANSPORT_DETECTED:'+file);}
const packed=run(['pack','--ignore-scripts','--json','--pack-destination',destination]),file=path.join(destination,packed.filename),sha256=digest(await fs.readFile(file));
await fs.writeFile(file+'.sha256',sha256+'  '+packed.filename+'\n');
const result={version:releaseVersion,status:'beta-work-in-progress',file,sha256,files:packed.files.length,bytes:packed.size};
await fs.writeFile(path.join(destination,'release-manifest.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
