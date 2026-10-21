import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const digest=data=>createHash('sha256').update(data).digest('hex');
const rootFiles=['README.md','README.en.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','package.json','.gitignore','.gitattributes','.editorconfig'];
const skippedSegments=new Set(['node_modules','.git','build-meta']);
const skippedExtensions=/\.(?:sqlite(?:-[a-z]+)?|db(?:-[a-z]+)?|log|bhbackup|tgz|zip|docx|pdf|pem|key)$/i;
const generated=['plugins/become-human-web/runtime/','plugins/become-human-web/runtime-bundle/','plugins/become-human-web/docs/','plugins/become-human-web/im/lib/'];
const omitted=new Set(['plugins/become-human-web/client.js','plugins/become-human-web/im-client.js','docs/assets/banner-concept.png','plugins/become-human-web/im/src/channels/shared/i18n-en/whatsapp.mjs']);
export function sourceAllowed(relative){
 const parts=relative.split('/');if(parts.some(part=>skippedSegments.has(part)||part==='whatsapp'))return false;
 if(skippedExtensions.test(relative)||omitted.has(relative)||generated.some(prefix=>relative.startsWith(prefix)))return false;
 if(relative.startsWith('plugins/become-human-web/im/assets/'))return ['dingtalk-menu-template.json','logo-icon.png','logo-plugin-message-link-gradient.webp'].includes(parts.at(-1));
 if(parts.at(-1).startsWith('.env')||['launch.json','runtime-selection.json','.credentials.yaml'].includes(parts.at(-1)))return false;
 return true;
}
export async function sourceFiles(){
 const files=[];
 async function walk(relative){const absolute=path.join(root,relative),stat=await fs.lstat(absolute);if(stat.isSymbolicLink())return;if(stat.isDirectory()){for(const child of (await fs.readdir(absolute)).sort()){const next=relative?relative+'/'+child:child;if(sourceAllowed(next))await walk(next);}}else if(stat.isFile()&&sourceAllowed(relative))files.push(relative);}
 for(const file of rootFiles)await walk(file);for(const directory of ['.github','docs','scripts','plugins/become-human','plugins/become-human-web'])await walk(directory);
 return [...new Set(files)].sort();
}
export function checkPublicText(file,bytes){
 if(!/\.(?:md|mjs|js|tsx|json|ya?ml|txt|svg|ps1)$/.test(file))return;
 const text=bytes.toString('utf8'),findings=[];
 if(/(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(text)||/\bsk-[A-Za-z0-9_-]{24,}/.test(text))findings.push('credential-like literal');
 if(/https?:\/\/[^\s"'<>]+[?&]token=[A-Za-z0-9_-]{20,}/.test(text))findings.push('authenticated URL');
 if(/[A-Z]:[\\/]Users[\\/](?!YOUR_NAME|YOUR_USER|USER_NAME|USERNAME|user(?:[\\/]|$)|example|<)[^\\/\s"<>]+[\\/]/i.test(text))findings.push('personal machine path');
 if(findings.length)throw Error('PUBLIC_EXPORT_REVIEW_REQUIRED:'+file+':'+findings.join(','));
}
export async function version(){return JSON.parse(await fs.readFile(path.join(root,'plugins/become-human-web/package.json'),'utf8')).version;}
