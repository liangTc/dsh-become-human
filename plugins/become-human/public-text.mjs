function decode(text){return text.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[x]));}
const markupTags=()=>/<\/?[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu;
const withoutMarkup=text=>text.replace(markupTags(),' ');
function contentFragment(html,{fragment}={}){
  let requested='';try{requested=decodeURIComponent(String(fragment??'').replace(/^#/u,''));}catch{}
  if(requested.length>500||/[\u0000-\u001f]/u.test(requested))requested='';
  const candidates=[],excluded=[],headings=[],anchors=[],visibleChars=withoutMarkup(html).replace(/\s+/g,' ').trim().length;
  for(const token of html.matchAll(markupTags())){
    const opening=/^<([a-z][a-z0-9:-]*)\b([\s\S]*)>$/iu.exec(token[0]);if(!opening)continue;opening.index=token.index;
    if(excluded.some(range=>opening.index>=range.start&&opening.index<range.end))continue;
    const tag=opening[1].toLowerCase(),attrs=opening[2];
    const attributes=Object.fromEntries([...attrs.matchAll(/\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)].map(match=>[match[1].toLowerCase(),match[2]??match[3]??match[4]??'']));
    const containers=[attributes.id,attributes.class,attributes.role].filter(Boolean).join(' ');
    // Layout state such as "has-sidebar" describes a content container,
    // rather than making that container navigation. Keep actual sidebar/nav
    // tokens and explicit roles eligible for chrome removal.
    const chromeClasses=(attributes.class??'').split(/\s+/u).filter(token=>!/^(?:has|with|without|no)[-_]/iu.test(token)).join(' ');
    const chromeContainers=[attributes.id,chromeClasses,attributes.role].filter(Boolean).join(' ');
    const inBody=candidates.some(candidate=>candidate.rank>=2&&opening.index>=candidate.start&&opening.index<candidate.end);
    // A visible article/main-local header often contains the title and actual
    // introductory definition. Its class name is not evidence of navigation.
    // Site-level headers and explicit banner/navigation roles remain chrome.
    const headerChrome=!inBody&&(tag==='header'||/(?:^|[\s_-])header(?=[\s_-]|$)/i.test(chromeContainers));
    const omit=Object.hasOwn(attributes,'hidden')||attributes['aria-hidden']?.trim().toLowerCase()==='true'||/(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(attributes.style??'')||/(?:^|[\s_-])(?:nav|menu|sidebar|footer|related)(?=[\s_-]|$)/i.test(chromeContainers)||headerChrome||/^(?:navigation|complementary|banner|contentinfo)$/i.test(attributes.role??'');
    // A chapter identifier such as "content.negotiation" describes a section,
    // not a page-wide content container. Match complete container tokens.
    const generic=[attributes.id??'',attributes.class??''].some(value=>value.split(/\s+/u).some(token=>/^(?:(?:main|page)[-_]?)?content(?:[-_](?:container|area|wrapper|body))?$/iu.test(token)));
    const rank=['article','main','div','section'].includes(tag)?/articlebody|trs[_ -]?(?:editor|ueditor)|(?:article|post|entry)[-_ ](?:body|content|text)/i.test(containers+' '+(attributes.itemprop??''))?4:tag==='article'?3:tag==='main'?2:generic?1:0:0;
    const anchored=!!requested&&(decode(attributes.id??'')===requested||tag==='a'&&decode(attributes.name??'')===requested);
    if(!omit&&/^h[1-6]$/u.test(tag))headings.push({start:opening.index,level:Number(tag[1])});
    if(anchored&&!omit)anchors.push({start:opening.index,tag});
    if(!omit&&(!rank||candidates.length>=40)&&!(anchored&&['section','article','main','div'].includes(tag)))continue;
    const endTag=markupTags();endTag.lastIndex=opening.index+opening[0].length;let depth=1,end,after;
    for(let next;(next=endTag.exec(html));){if(/^<\/?([a-z][a-z0-9:-]*)/iu.exec(next[0])?.[1].toLowerCase()!==tag)continue;depth+=next[0].startsWith('</')?-1:next[0].endsWith('/>')?0:1;if(!depth){end=next.index;after=end+next[0].length;break;}}
    if(end!==undefined){if(omit){excluded.push({start:opening.index,end:after});continue;}const start=opening.index+opening[0].length,body=html.slice(start,end),chars=withoutMarkup(body).replace(/\s+/g,' ').trim().length;candidates.push({rank,start,end,chars,...(anchored?{anchorStart:opening.index}:{})});}
  }
  // A weakly named div must cover a substantial part of the page before it
  // can replace the document. Otherwise retain it all for query-based slicing.
  const hidden=at=>excluded.some(range=>at>=range.start&&at<range.end),visibleAnchors=anchors.filter(anchor=>!hidden(anchor.start));
  let bounded,fragmentMatched=false;
  // Duplicate visible IDs are ambiguous: never choose a convenient occurrence.
  if(visibleAnchors.length===1){
    const anchor=visibleAnchors[0],container=candidates.find(row=>row.anchorStart===anchor.start),heading=headings.filter(row=>row.start<=anchor.start&&!hidden(row.start)).at(-1);
    if(container)bounded={start:container.start,end:container.end,kind:'container'};
    else if(heading){const next=headings.find(row=>row.start>anchor.start&&row.level<=heading.level&&!hidden(row.start));bounded={start:heading.start,end:next?.start??html.length,kind:'heading'};}
    fragmentMatched=!!bounded;
  }
  const selected=bounded??candidates.filter(x=>x.chars>=100&&(x.rank>1||x.chars>=visibleChars/3)).sort((a,b)=>b.rank-a.rank||b.chars-a.chars)[0],start=selected?.start??0,end=selected?.end??html.length,parts=[];let cursor=start;
  for(const range of excluded){if(range.end<=start||range.start>=end)continue;parts.push(html.slice(cursor,Math.max(cursor,range.start)));cursor=Math.min(end,Math.max(cursor,range.end));}
  parts.push(html.slice(cursor,end));return {text:parts.join(' '),scope:{version:1,kind:bounded?'url-fragment-section':'document-body',fragmentRequested:!!requested,fragmentMatched,...(bounded?{boundary:bounded.kind}:{})}};
}
export function sourceProjection(text,type,{fragment,markdown=false}={}){
  let scope={version:1,kind:markdown?'markdown-visible-text':'document-body',fragmentRequested:!!fragment,fragmentMatched:false};
  if(/html|xml/.test(type)){text=text.replace(/<(script|style|nav|aside|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<(script|style)\b[^>]*>[\s\S]*$/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');if(type.includes('html')){const projected=contentFragment(text,{fragment});text=projected.text;scope=projected.scope;}text=withoutMarkup(text);}
  else if(markdown||/markdown/iu.test(type)){
    text=text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u,'').replace(/^[ \t]*(?:\x60{3,}|~{3,})[^\r\n]*$/gmu,'').replace(/^[ \t]*(?:>[ \t]*)+/gmu,'').replace(/^[ \t]*\[![A-Z]+\][ \t]*$/gmu,'').replace(/^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?::[ \t]*)?)/gmu,'').replace(/\[([^\]\r\n]+)\]\([^\s)]+\)/gu,'$1').replace(/\x60+([^\x60\r\n]+)\x60+/gu,'$1');
  }
  return {text:decode(text).replace(/\s+/g,' ').trim(),scope};
}
export function sourceText(text,type,options){return sourceProjection(text,type,options).text;}

export function pageMetadata(body,type){
  if(!type.includes('html'))return {};
  const title=sourceText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]??'','text/html').slice(0,100);
  let publishedAt=null;
  for(const tag of body.match(/<meta\b[^>]*>/gi)??[]){const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),decode(m[3])]));if(/^(?:article:published_time|datePublished|date)$/i.test(attrs.property??attrs.name??'')&&attrs.content?.length<=100&&Number.isFinite(Date.parse(attrs.content))){publishedAt=new Date(attrs.content).toISOString();break;}}
  return {title,publishedAt,publishedAtStatus:publishedAt?'publisher-reported':'unknown'};
}
