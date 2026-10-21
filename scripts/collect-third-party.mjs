import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Regenerate notices from an actual completed IM build, not from all installed
// development dependencies. The optional argument selects another build root.
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.resolve(repository,process.argv[2]??'plugins/become-human-web');
const destination=path.join(web,'im/licenses');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const sourceIndex=await readJson(path.join(destination,'SOURCES.json'));
const buildManifest=await readJson(path.join(web,'im/BUILD-MANIFEST.json'));
for(const [kind,file] of [['host','im/lib/index.js'],['client','im-client.js']]){
  if(sha(await fs.readFile(path.join(web,file)))!==buildManifest[kind]?.sha256)throw Error('BUILD_OUTPUT_CHANGED:'+kind);
}
const metafiles=[];
for(const name of ['im-host','im-client']){
  const bytes=await fs.readFile(path.join(web,'build-meta',name+'.metafile.json'));
  metafiles.push({name,sha256:sha(bytes),data:JSON.parse(bytes)});
}
const packageRoots=new Set();
for(const {data} of metafiles)for(const name of Object.keys(data.inputs)){
  const normalized=name.replaceAll('\\','/'),marker='node_modules/',start=normalized.lastIndexOf(marker);
  if(start<0)continue;
  const suffix=normalized.slice(start+marker.length).split('/'),length=suffix[0].startsWith('@')?2:1;
  packageRoots.add(path.resolve(web,normalized.slice(0,start+marker.length)+suffix.slice(0,length).join('/')));
}
const permitted=new Set(['MIT','ISC','BSD-2-Clause','BSD-3-Clause','Apache-2.0','0BSD','CC0-1.0','Unlicense','BlueOak-1.0.0']);
const records=new Map();
for(const directory of [...packageRoots].sort()){
  const manifest=await readJson(path.join(directory,'package.json'));
  const license=typeof manifest.license==='string'?manifest.license:manifest.license?.type;
  if(!manifest.name||!manifest.version||!license||/\b(?:A?GPL|LGPL|SSPL|UNLICENSED)\b/i.test(license)||!permitted.has(license))throw Error('LICENSE_REVIEW_REQUIRED:'+manifest.name+'@'+manifest.version+':'+license);
  let fileNames=(await fs.readdir(directory,{withFileTypes:true})).filter(file=>file.isFile()&&/^(?:licen[cs]e|copying|notice)(?:[.-].+)?$/i.test(file.name)).map(file=>file.name).sort();
  const textFiles=[];
  for(const file of fileNames){const bytes=await fs.readFile(path.join(directory,file));textFiles.push({file,bytes,source:'installed package license files'});}
  const hasLicense=fileNames.some(file=>/^(?:licen[cs]e|copying)(?:[.-].+)?$/i.test(file));
  if(!hasLicense){
    if(!['agent-base','https-proxy-agent'].includes(manifest.name)||license!=='MIT')throw Error('LICENSE_TEXT_MISSING:'+manifest.name+'@'+manifest.version);
    const source=sourceIndex.files.find(row=>row.file==='PROXY-AGENTS-MIT.txt');
    if(!source)throw Error('OFFICIAL_PROXY_LICENSE_SOURCE_MISSING');
    const bytes=await fs.readFile(path.join(destination,source.file));if(sha(bytes)!==source.sha256)throw Error('OFFICIAL_PROXY_LICENSE_CHANGED');
    textFiles.unshift({file:source.file,bytes,source:source.source});
  }
  const record={name:manifest.name,version:manifest.version,license,licenseSource:hasLicense?'installed package license files':'official upstream license; see SOURCES.json',licenseFiles:textFiles.map(({file,bytes,source})=>({file,sha256:sha(bytes),bytes:bytes.length,...(source.startsWith('https:')?{sourceUrl:source}:{})})),textFiles};
  const key=record.name+'@'+record.version,existing=records.get(key);
  if(existing&&JSON.stringify(existing.licenseFiles)!==JSON.stringify(record.licenseFiles))throw Error('DUPLICATE_PACKAGE_LICENSE_CONFLICT:'+key);
  records.set(key,record);
}
const packages=[...records.values()].sort((left,right)=>left.name.localeCompare(right.name)||left.version.localeCompare(right.version));
const document={auditDate:new Date().toISOString().slice(0,10),scope:'Actual Apache release IM host/client build inputs; external runtime dependencies are not bundled.',inputsManifest:'../BUILD-MANIFEST.json',metafiles:metafiles.map(({name,sha256})=>({name,sha256})),packages:packages.map(({textFiles,...record})=>record)};
const chunks=['Third-party license texts for the Apache release IM build','Generated from actual IM host/client inputs. The original copyright and license terms below remain in force.','External npm runtime dependencies, the DSH Host, and excluded WhatsApp/Baileys code are not included here.',''];
for(const record of packages){chunks.push('='.repeat(78),record.name+' '+record.version+' ('+record.license+')','Source: '+record.licenseSource,'');for(const {file,bytes} of record.textFiles)chunks.push('--- '+file+' ---',bytes.toString('utf8').trimEnd(),'');}
await fs.writeFile(path.join(destination,'BUNDLED-DEPENDENCIES.json'),JSON.stringify(document,null,2)+'\n');
await fs.writeFile(path.join(destination,'BUNDLED-DEPENDENCIES.txt'),chunks.join('\n')+'\n');
await fs.writeFile(path.join(destination,'INDEX.md'),'# IM 构建依赖许可证\n\n本目录保留实际发行构建内 '+packages.length+' 个第三方 npm 包版本的完整许可证正文、版权及摘要。清单按 Host/Client 实际构建输入生成，不把上层 SDK 的许可替代为传递依赖许可。\n\n- [完整许可证合辑](BUNDLED-DEPENDENCIES.txt)\n- [包版本、许可证与正文摘要](BUNDLED-DEPENDENCIES.json)\n- [构建来源清单](../BUILD-MANIFEST.json)\n- [腾讯 openclaw-weixin MIT](OPENCLAW-WEIXIN-MIT.txt)\n- [DingTalk connector MIT](DINGTALK-CONNECTOR-MIT.txt)\n- [Simple Icons CC0](SIMPLE-ICONS-CC0.txt)\n- [Proxy agents MIT](PROXY-AGENTS-MIT.txt)\n\n缺少包内许可证全文的 agent-base / https-proxy-agent 使用已保留的官方 proxy-agents MIT 文本，来源与摘要见 [SOURCES.json](SOURCES.json)。WhatsApp/Baileys、libsignal 和 whatsapp-rust-bridge 不属于此发行构建。外部安装依赖保留各包自己的许可证。\n\n在完成 IM 构建后，从仓库根运行 `node scripts/collect-third-party.mjs` 重新生成；可额外传入另一个 Web 构建目录。脚本发现未审核许可、GPL 或无许可源码时拒绝生成。\n');
console.log(JSON.stringify({packages:packages.length,licenses:[...new Set(packages.map(record=>record.license))].sort(),metafiles:document.metafiles,output:'im/licenses/BUNDLED-DEPENDENCIES.*'}));
