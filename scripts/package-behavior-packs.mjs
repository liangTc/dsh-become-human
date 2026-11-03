import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {root,digest,checkPublicText} from './release-files.mjs';
const output=path.join(root,'dist','packages'),source=path.join(root,'plugins','become-human','behavior-packs'),results=[];
await fs.mkdir(output,{recursive:true});
const npm=process.env.npm_execpath??path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
for(const folder of (await fs.readdir(source)).sort()){
 const dir=path.join(source,folder);if(!(await fs.lstat(dir)).isDirectory())continue;
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'package.json')));
 const run=args=>{const p=spawnSync(process.execPath,[npm,...args],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});if(p.status!==0)throw Error('BEHAVIOR_PACK_FAILED');return JSON.parse(p.stdout)[0];};
 for(const file of run(['pack','--ignore-scripts','--dry-run','--json']).files){if(/node_modules|\.env|\.sqlite|\.dsh-verify/.test(file.path))throw Error('BEHAVIOR_PACK_PRIVATE_FILE');checkPublicText(file.path,await fs.readFile(path.join(dir,file.path)));}
 const packed=run(['pack','--ignore-scripts','--json','--pack-destination',output]),file=path.join(output,packed.filename),sha256=digest(await fs.readFile(file));
 await fs.writeFile(file+'.sha256',sha256+'  '+packed.filename+'\n');results.push({name:manifest.name,version:manifest.version,status:'experimental',file,sha256,files:packed.files.length,bytes:packed.size});
}
await fs.writeFile(path.join(output,'behavior-packs.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
