import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const skillUrl=new URL('./skills/humanizer/SKILL.md',import.meta.url);
const adapterUrl=new URL('./skills/zhiqiu-expression/SKILL.md',import.meta.url);
const provenance=JSON.parse(fs.readFileSync(new URL('./skills/humanizer/provenance.json',import.meta.url),'utf8'));
const upstream=fs.readFileSync(skillUrl,'utf8'),adapter=fs.readFileSync(adapterUrl,'utf8');
const digest=text=>createHash('sha256').update(text).digest('hex');
if(digest(upstream)!==provenance.files['SKILL.md'].sha256)throw new Error('HUMANIZER_RESOURCE_MISMATCH');
const body=text=>text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
const compact=body(adapter);
const phases=new Set(['foreground','care','chat','share-insight','learning']);

export function expressionPrompt(phase){
  if(!phases.has(phase))return '';
  const fields=phase==='learning'?'本轮只将表达规则应用于 summary、relevance、share 的自然语言；简短聊天要求仅适用于 share。笔记的 summary、relevance、claims 按知识和证据需要写完整，证据不足时遵守原协议。':phase==='foreground'?'本轮直接给出一次最终聊天回复。日常交流通常 1 至 3 个短句，不靠额外润色、机械截断或拆成连续多条来变短；主人明确要求详细内容时按需充分回答。':'本轮只将表达规则应用于 JSON 的 text 字段；通常只分享一条发现、一个感受或一份关心，最多一个自然相关的问题，不强求提问；字段和任务协议照常保留。';
  return '\n\n'+compact+'\n'+fields;
}

export function expressionSkills(){
  return [
    {name:'humanizer',description:'Humanizer 3.1.0: edit prose to remove stock AI writing patterns while preserving meaning and facts.',content:body(upstream),path:fileURLToPath(skillUrl),metadata:{version:provenance.version,commit:provenance.commit}},
    {name:'zhiqiu-expression',description:'Human 通用中文对话适配：只沿用当前人格、短句接话、减少套话，保留事实及结构；技能 ID 为兼容旧配置保留。',content:compact,path:fileURLToPath(adapterUrl),metadata:{version:'1.2.0',basedOn:'humanizer@'+provenance.version}}
  ].map(skill=>({...skill,source:'bundled',provider:'become-human-expression',resourceBase:{kind:'directory',path:path.dirname(skill.path)},invocation:{modelInvocable:true,userInvocable:true}}));
}

export function expressionStatus(registryRegistered=false){
  return {enabled:true,registryRegistered,upstream:{name:'humanizer',version:provenance.version,commit:provenance.commit,sha256:provenance.files['SKILL.md'].sha256},adapter:{name:'zhiqiu-expression',version:'1.2.0',sha256:digest(adapter)},activeMode:'compact-chinese-embedded',phases:[...phases],extraModelCalls:0,promptUtf8Bytes:Buffer.byteLength(expressionPrompt('foreground'),'utf8')};
}
