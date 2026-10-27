import {questionSignals,retrievalTerms} from './knowledge-signals.mjs';
const generic=new Set(['report','reports','write','create','generate','make','saved','existing','notes','note','learning','please','only','brief','definition','minimal','source','sources','public','document','documentation','api','mdn','报告','笔记','学习','生成','整理','保存','资料','来源','材料','主题','原文','已有','公开','请','仅','关于','本次','当前']);
const clean=text=>String(text??'').replace(/【[^】]*】|\[(?:dev[^\]]*|test[^\]]*)\]|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,' ').replace(/生成|整理|保存|学习笔记|学习报告|已有笔记|公开资料|开发测试|本轮测试|最小定义|来源报告|报告|笔记|材料|请帮我|请你|请|仅从|只根据|只依据|汇总|总结|我的|本地|文件|所选|全部|所有|这些|这两份|这份|一份|两份/gu,' ');
const searchable=note=>[note.title,note.summary,...(note.claims??[]).map(c=>c.text),note.source?.url].filter(Boolean).join('\n').normalize('NFKC').toLowerCase();
export function reportMaterialMatches(query,note,{minHits=2}={}){
  const text=clean(query),observed=searchable(note),signals=questionSignals(text);
  const identifiers=[...new Set([...signals.httpStatusCodes,...(text.match(/[A-Za-z][A-Za-z0-9_.+-]{1,}/g)??[]).filter(w=>/[a-z][A-Z]|[A-Za-z]\d/u.test(w)).map(w=>w.toLowerCase())])];
  const has=word=>/^\d+$/u.test(word)?new RegExp('(?:^|[^a-z0-9])'+word+'(?:$|[^a-z0-9])','u').test(observed):observed.includes(word);
  if(identifiers.length)return identifiers.some(has);
  const terms=retrievalTerms(text,{expand:false,limit:40}).filter(t=>!generic.has(t));
  return !terms.length||terms.filter(has).length>=Math.min(minHits,terms.length);
}
export function assertReportMaterials({title,noteIds,ownerText,reviewedIds,notes}){
  const fail=code=>{throw new Error(code);};
  if(!ownerText?.trim())fail('REPORT_REQUEST_CONTEXT_MISSING');
  if(noteIds.some(id=>!reviewedIds.has(id)))fail('REPORT_MATERIALS_NOT_REVIEWED');
  for(const id of noteIds){const note=notes.find(n=>n.id===id);if(!note)fail('ACTION_SOURCE_INVALID');
    const explicitlySelected=noteIds.every(selected=>ownerText.includes(selected));
    if(!reportMaterialMatches(title,note)||!explicitlySelected&&!reportMaterialMatches(ownerText,note,{minHits:1}))fail('REPORT_MATERIAL_TOPIC_MISMATCH');
  }
}
