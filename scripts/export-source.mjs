import fs from 'node:fs/promises';
import path from 'node:path';
import {root,sourceFiles,digest,checkPublicText,version} from './release-files.mjs';
const releaseVersion=await version(),destination=path.resolve(root,process.argv[2]??'dist/source/become-human-'+releaseVersion),allowedRoot=path.join(root,'dist','source');
if(!destination.startsWith(allowedRoot+path.sep))throw Error('SOURCE_EXPORT_MUST_STAY_INSIDE_DIST_SOURCE');
try{await fs.lstat(destination);throw Error('DESTINATION_ALREADY_EXISTS: choose a fresh directory name');}catch(error){if(error.code!=='ENOENT')throw error;}
const files=await sourceFiles(),manifest=[];
const publicBytes=(file,bytes)=>/\.(?:md|mjs|js|tsx|json|ya?ml|txt|svg|css|html|ps1)$|(?:^|\/)(?:LICENSE|NOTICE|\.gitignore|\.gitattributes|\.editorconfig)$/.test(file)?Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n').replace(/\n/g,file.endsWith('.ps1')?'\r\n':'\n')):bytes;
// Audit every file before creating any publishable export.
for(const file of files){const bytes=publicBytes(file,await fs.readFile(path.join(root,file)));checkPublicText(file,bytes);manifest.push({path:file,bytes:bytes.length,sha256:digest(bytes)});}
await fs.mkdir(destination,{recursive:true});
for(const file of files){const target=path.join(destination,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,publicBytes(file,await fs.readFile(path.join(root,file))));}
await fs.writeFile(path.join(destination,'SOURCE-MANIFEST.json'),JSON.stringify({format:1,version:releaseVersion,status:'beta-work-in-progress',files:manifest},null,2)+'\n');
console.log(JSON.stringify({destination,version:releaseVersion,files:files.length,privateRuntimeIncluded:false,symlinksIncluded:false}));
