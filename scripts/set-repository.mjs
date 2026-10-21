import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './release-files.mjs';
const value=process.argv[2];let url;try{url=new URL(value);}catch{throw Error('Usage: node scripts/set-repository.mjs https://github.com/OWNER/REPOSITORY');}
if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.search||url.hash||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname))throw Error('INVALID_GITHUB_REPOSITORY_URL');
const repository=url.href.replace(/\/$/,'').replace(/\.git$/,'');
for(const [file,directory] of [['package.json',null],['plugins/become-human-web/package.json','plugins/become-human-web'],['plugins/become-human/package.json','plugins/become-human']]){const filename=path.join(root,file),pkg=JSON.parse(await fs.readFile(filename,'utf8'));pkg.repository={type:'git',url:'git+'+repository+'.git',...(directory?{directory}:{})};pkg.homepage=repository+'#readme';pkg.bugs={url:repository+'/issues'};await fs.writeFile(filename,JSON.stringify(pkg,null,2)+'\n');}
console.log(JSON.stringify({repository,updated:3,published:false}));
