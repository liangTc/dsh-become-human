import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let api;
function getApi(){
  if(process.platform!=='win32')throw new Error('UNSUPPORTED_KEY_PLATFORM');
  if(api)return api;
  // Koffi is the pinned native dependency already used by DSH's Windows JSONL backend.
  const owner=createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json')),koffi=owner('koffi');
  const Blob=koffi.struct({cbData:'uint32_t',pbData:'void *'}),crypt=koffi.load('crypt32.dll'),kernel=koffi.load('kernel32.dll');
  const args=[koffi.pointer(Blob),'void *','void *','void *','void *','uint32_t',koffi.out(koffi.pointer(Blob))];
  api={koffi,protect:crypt.func('__stdcall','CryptProtectData','int32_t',args),unprotect:crypt.func('__stdcall','CryptUnprotectData','int32_t',args),free:kernel.func('__stdcall','LocalFree','void *',['void *'])};return api;
}
export function protectKey(operation,text){
  const a=getApi(),input=Buffer.from(text,operation==='protect'?'hex':'base64'),out={};
  const ok=a[operation]({cbData:input.length,pbData:input},null,null,null,null,1,out);
  if(!ok)throw new Error('KEY_PROTECTION_FAILED');
  try{return Buffer.from(a.koffi.decode(out.pbData,'uint8_t',out.cbData)).toString(operation==='protect'?'base64':'hex');}finally{a.free(out.pbData);input.fill(0);}
}
