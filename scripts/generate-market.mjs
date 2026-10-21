import fs from 'node:fs/promises';
import path from 'node:path';
import {root} from './release-files.mjs';
const [repository,commit]=process.argv.slice(2);
if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository??'')||!/^[0-9a-f]{40}$/.test(commit??''))throw Error('Usage: node scripts/generate-market.mjs https://github.com/OWNER/REPOSITORY FULL_40_HEX_COMMIT');
const pkg=JSON.parse(await fs.readFile(path.join(root,'plugins/become-human-web/package.json'),'utf8'));
const repositoryPath=repository.slice('https://github.com/'.length),prefix='https://raw.githubusercontent.com/'+repositoryPath+'/'+commit+'/plugins/become-human-web/';
async function response(file,method='GET'){const result=await fetch(prefix+file,{method,redirect:'error',signal:AbortSignal.timeout(15000)});if(!result.ok)throw Error('GIT_REVISION_HAS_NO_INSTALLABLE_BUNDLE:'+file);return result;}
// Git market entries must point to a revision with actual installable outputs.
// A source-only revision is not silently advertised as a prebuilt bundle.
const remote=await (await response('runtime-bundle/package.json')).json();if(remote.version!==pkg.version)throw Error('GIT_BUNDLE_VERSION_MISMATCH');
for(const file of ['manager.mjs','client.js','im/lib/index.js','runtime/index.mjs'])await response(file,'HEAD');
const icon='data:image/svg+xml;base64,'+(await fs.readFile(path.join(root,'docs/assets/icon-pixel.svg'))).toString('base64');
const index={format:1,title:{en:'Become Human · Beta',zh:'Become Human · 测试版'},description:{en:'Experimental community plugin. Work in progress.',zh:'社区自主 Agent 插件；测试版本，尚未开发完成。'},plugins:[{name:pkg.name,title:{en:'Become Human · Beta',zh:'Become Human · 自主 Agent 测试版'},description:{en:'Single-session autonomous companion for DSH Web. Work in progress.',zh:'统一人格、记忆、学习与主动行为的 DSH Web 单会话 Agent，尚未开发完成。'},author:pkg.author,icon,homepage:repository+'#readme',repository:{url:repository,directory:'plugins/become-human-web'},versions:[{version:pkg.version,publishTimestamp:Math.floor(Date.now()/1000),source:{type:'git',url:repository,commit,path:'plugins/become-human-web'},engines:{dsh:'0.2.0-rc.2'}}]}]};
const destination=path.join(root,'dist/market/index.json');await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify(index,null,2)+'\n');console.log(JSON.stringify({destination,version:pkg.version,sourceVerified:true,published:false,officiallyListed:false}));
