// Explicit first-person statements only. Each preference has its own slot;
// adding tea must not replace coffee or an unrelated interest.
import {developmentInput} from './knowledge-signals.mjs';
export const preferenceKey=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/\s+/gu,'').replace(/[。！!，,；;]+$/gu,'');
function listedValues(value){
  // Split only an explicit short enumeration. Quoted titles and phrases about
  // a relationship, a mixture or an activity remain one verbatim preference;
  // this parser does not infer the independent parts of a combined interest.
  if(!/[、和与]/u.test(value)||/["'“”‘’《》「」『』()（）【】]/u.test(value)||/的|关系|之间|搭配|组合|混合|拼配|调配|配方|一起|同时|一块|加|兑|掺|佐|配着|伴着|共和国|共和|协和|和谐|和弦|和声|饱和|中和|调和|亲和|温和|暖和/u.test(value))return [value];
  const values=value.split(/[、和与]/u).map(part=>part.trim());
  if(values.length<2||values.length>8||values.some(part=>!part||!/^[\p{Script=Han}A-Za-z0-9.+# -]{1,24}$/u.test(part)))return [value];
  return [...new Map(values.map(part=>[preferenceKey(part),part])).values()];
}
export function preferenceStatements(body){
  if(typeof body!=='string'||developmentInput(body)||/[?？]|假设|比如|测试|如果|怎样|什么/u.test(body))return [];
  const result=[];let ownerStatement=false;
  for(const clause of body.split(/[。！!\n，,；;]/u)){
    const text=clause.trim();
    const negative=/^(?:我(?:现在|已经)?|我也)(?:不再喜欢|不再偏好|不喜欢)(.{1,80}?)了?$/u.exec(text);
    const positive=/^(?:我(?:也|还|现在)?|也|还)(?:喜欢|偏好)(.{1,80})$/u.exec(text);
    const match=negative??positive;if(!match){ownerStatement=false;continue;}
    if(!text.startsWith('我')&&!ownerStatement)continue;
    const value=match[1].trim();if(!value||/^(?:不|没)|(?:而是|但是|不过|改为|以前|过去|曾经)/u.test(value))continue;
    ownerStatement=true;for(const item of listedValues(value))result.push({value:item,...(negative?{polarity:'dislike'}:{})});
  }
  return result.slice(0,8);
}
export function preferenceSupported(payload,body){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.entity!=='user'||payload.predicate!=='preference'||Object.keys(payload).some(key=>!['entity','predicate','value','polarity'].includes(key))||payload.polarity!==undefined&&!['like','dislike'].includes(payload.polarity))return false;
  return preferenceStatements(body).some(p=>p.value===payload.value&&(p.polarity??'like')===(payload.polarity??'like'));
}
