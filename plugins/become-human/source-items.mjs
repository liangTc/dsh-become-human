import {createHash} from 'node:crypto';
import {sourceText} from './public-text.mjs';
import {researchUrl} from './public-document.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw Error(code);};
const ATOM='http://www.w3.org/2005/Atom',CONTENT='http://purl.org/rss/1.0/modules/content/',DC='http://purl.org/dc/elements/1.1/';
export const sourceItemPolicy=Object.freeze({version:2,maxItems:256,maxHistory:4096,maxXmlNodes:30000,maxXmlDepth:48});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const normalize=value=>String(value??'').normalize('NFC').replace(/\s+/gu,' ').trim();
function entities(value){
  return value.replace(/&([^;]*);/g,(_,name)=>{
    if(Object.hasOwn({amp:1,lt:1,gt:1,quot:1,apos:1},name))return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name];
    if(!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name))fail('SOURCE_FEED_XML_INVALID');
    const code=name[1]==='x'?parseInt(name.slice(2),16):Number(name.slice(1));
    if(!(code===9||code===10||code===13||code>=32&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)))fail('SOURCE_FEED_XML_INVALID');
    return String.fromCodePoint(code);
  });
}
// Bounded XML subset for feed containers. No DTD, external entities, network
// resolution or executable content. Unknown namespaces are never RSS/Atom.
export function parseFeedXml(body,baseUrl){
  if(Buffer.byteLength(body)>2*1024*1024||/<!\s*(?:DOCTYPE|ENTITY)/i.test(body)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body))fail('SOURCE_FEED_XML_INVALID');
  const document={parts:[],children:[],ns:{xml:'http://www.w3.org/XML/1998/namespace'},base:baseUrl??null},stack=[document];let pos=0,nodes=0;
  const append=text=>{if(!text)return;if(/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|(?:amp|lt|gt|quot|apos);)/.test(text))fail('SOURCE_FEED_XML_INVALID');stack.at(-1).parts.push(entities(text));};
  while(pos<body.length){
    if(body[pos]!=='<'){const end=body.indexOf('<',pos);append(body.slice(pos,end<0?body.length:end));pos=end<0?body.length:end;continue;}
    if(body.startsWith('<!--',pos)){const end=body.indexOf('-->',pos+4);if(end<0||body.slice(pos+4,end).includes('--'))fail('SOURCE_FEED_XML_INVALID');pos=end+3;continue;}
    if(body.startsWith('<![CDATA[',pos)){const end=body.indexOf(']]>',pos+9);if(end<0||stack.length===1)fail('SOURCE_FEED_XML_INVALID');stack.at(-1).parts.push(body.slice(pos+9,end));pos=end+3;continue;}
    if(body.startsWith('<?',pos)){const end=body.indexOf('?>',pos+2);if(end<0)fail('SOURCE_FEED_XML_INVALID');pos=end+2;continue;}
    const match=/^<(\/?)([A-Za-z_][\w.:-]*)([\s\S]*?)>/.exec(body.slice(pos));if(!match)fail('SOURCE_FEED_XML_INVALID');
    const [raw,closing,name,tail]=match;pos+=raw.length;
    if(closing){if(tail.trim()||stack.length===1||stack.at(-1).name!==name)fail('SOURCE_FEED_XML_INVALID');stack.pop();continue;}
    // A > inside a quoted attribute is unsupported rather than misparsed.
    const self=/\/\s*$/.test(tail),attributes=self?tail.replace(/\/\s*$/,''):tail,attrs=Object.create(null);let rest=attributes;
    while(rest.trim()){
      const a=/^\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(rest);if(!a||Object.hasOwn(attrs,a[1]))fail('SOURCE_FEED_XML_INVALID');
      const value=a[3]??a[4];if(/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|(?:amp|lt|gt|quot|apos);)/.test(value))fail('SOURCE_FEED_XML_INVALID');
      attrs[a[1]]=entities(value);rest=rest.slice(a[0].length);
    }
    const parent=stack.at(-1),ns={...parent.ns};for(const [key,value] of Object.entries(attrs))if(key==='xmlns')ns['']=value;else if(key.startsWith('xmlns:'))ns[key.slice(6)]=value;
    const split=name.split(':');if(split.length>2||split.length===2&&!ns[split[0]])fail('SOURCE_FEED_XML_INVALID');
    const node={name,local:split.at(-1),uri:ns[split.length===2?split[0]:'']??'',attrs,ns,base:attrs['xml:base']?newBase(attrs['xml:base'],parent.base):parent.base,children:[],parts:[]};
    parent.children.push(node);parent.parts.push(node);if(++nodes>sourceItemPolicy.maxXmlNodes||stack.length>=sourceItemPolicy.maxXmlDepth)fail('SOURCE_FEED_TOO_LARGE');
    if(!self)stack.push(node);
  }
  if(stack.length!==1||document.children.length!==1||document.parts.some(p=>typeof p==='string'&&p.trim()))fail('SOURCE_FEED_XML_INVALID');
  return document.children[0];
}
function newBase(value,parent){try{return new URL(value,parent??undefined).href;}catch{fail('SOURCE_FEED_URL_INVALID');}}
const children=(node,name,uri=node.uri)=>node.children.filter(c=>c.local===name&&c.uri===uri);
const child=(node,name,uri=node.uri)=>children(node,name,uri)[0];
const rawText=node=>node?.parts.map(p=>typeof p==='string'?p:rawText(p)).join(' ')??'';
const text=node=>normalize(rawText(node));
function safeLink(value,base){
  if(!value)return null;try{const url=new URL(value,base);return researchUrl(url.href);}catch{fail('SOURCE_FEED_URL_INVALID');}
}
const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const htmlText=value=>sourceText(String(value??''),'text/html');
function rich(node){
  if(!node)return '';
  return normalize(node.attrs.type==='xhtml'?rawText(node):node.attrs.type==='html'?htmlText(rawText(node)):rawText(node));
}
function item(input){
  const id=String(input.id??'').trim();if(!id||id.length>2048||!input.title&&!input.content)fail('SOURCE_FEED_ITEM_INVALID');
  const content=normalize(input.content),title=normalize(input.title),links=[...new Set(input.links??[])].filter(Boolean).sort();
  const authors=[...new Set(input.authors??[])].map(normalize).filter(Boolean).sort(),tags=[...new Set(input.tags??[])].map(normalize).filter(Boolean).sort();
  const basis={title,content,link:input.link??null,links,authors,tags};
  return {key:digest(id),id,title,content,link:input.link??null,publishedAt:date(input.publishedAt),updatedAt:date(input.updatedAt),authors,tags,digest:digest(basis)};
}
function htmlLinks(body,base){return [...String(body).matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(m=>safeLink(htmlText(m[1]),base));}
function xhtmlLinks(node){return node.children.flatMap(n=>[...['href','src'].filter(k=>n.attrs[k]).map(k=>safeLink(n.attrs[k],n.base)),...xhtmlLinks(n)]);}
function atomItems(root,url){
  if(root.uri!==ATOM||root.local!=='feed')fail('SOURCE_FEED_FORMAT_UNSUPPORTED');
  return children(root,'entry').map(entry=>{
    const base=newBase(entry.base??'',url)||url,linkNode=children(entry,'link').find(n=>!n.attrs.rel||n.attrs.rel==='alternate');
    const link=safeLink(linkNode?.attrs.href,linkNode?.base??base),content=child(entry,'content'),summary=child(entry,'summary'),title=rich(child(entry,'title'));
    if(content?.attrs.src)fail('SOURCE_FEED_EXTERNAL_CONTENT_UNSUPPORTED');
    const contentText=[rich(summary),rich(content)].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' ');
    const inlineLinks=[content,summary].filter(Boolean).flatMap(n=>n.attrs.type==='xhtml'?xhtmlLinks(n):n.attrs.type==='html'?htmlLinks(rawText(n),n.base??base):[]);
    return item({id:text(child(entry,'id')),title,content:contentText,link,publishedAt:text(child(entry,'published')),updatedAt:text(child(entry,'updated')),authors:children(entry,'author').map(n=>text(child(n,'name'))),tags:children(entry,'category').map(n=>n.attrs.term),links:[...children(entry,'link').filter(n=>n.attrs.rel==='enclosure').map(n=>safeLink(n.attrs.href,n.base??base)),...inlineLinks]});
  });
}
function rssItems(root,url){
  if(root.local!=='rss'||root.uri||root.attrs.version!=='2.0'||children(root,'channel').length!==1)fail('SOURCE_FEED_FORMAT_UNSUPPORTED');
  return children(child(root,'channel'),'item').map(entry=>{
    const base=newBase(entry.base??'',url)||url,link=safeLink(text(child(entry,'link')),base),description=rawText(child(entry,'description')),encoded=rawText(child(entry,'encoded',CONTENT)),title=htmlText(text(child(entry,'title')));
    const content=[htmlText(description),htmlText(encoded)].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).join(' ');
    return item({id:text(child(entry,'guid'))||link||(title?'title:'+normalize(title):null),title,content,link,publishedAt:text(child(entry,'pubDate')),authors:[text(child(entry,'author')),text(child(entry,'creator',DC))],tags:children(entry,'category').map(text),links:[...children(entry,'enclosure').map(n=>safeLink(n.attrs.url,base)),...htmlLinks(description+' '+encoded,base)]});
  });
}
function jsonItems(feed,url){
  if(!plain(feed)||!['https://jsonfeed.org/version/1','https://jsonfeed.org/version/1.1'].includes(feed.version)||typeof feed.title!=='string'||!Array.isArray(feed.items))fail('SOURCE_FEED_JSON_INVALID');
  return feed.items.map(row=>{
    if(!plain(row)||typeof row.id!=='string'||typeof row.content_text!=='string'&&typeof row.content_html!=='string')fail('SOURCE_FEED_ITEM_INVALID');
    const optional=['title','url','summary','content_html','content_text','date_published','date_modified'];if(optional.some(k=>row[k]!==undefined&&typeof row[k]!=='string'))fail('SOURCE_FEED_ITEM_INVALID');
    if(row.attachments!==undefined&&(!Array.isArray(row.attachments)||row.attachments.some(a=>!plain(a)||typeof a.url!=='string'))||row.authors!==undefined&&(!Array.isArray(row.authors)||row.authors.some(a=>!plain(a)||a.name!==undefined&&typeof a.name!=='string'))||row.tags!==undefined&&(!Array.isArray(row.tags)||row.tags.some(t=>typeof t!=='string')))fail('SOURCE_FEED_ITEM_INVALID');
    return item({id:row.id,title:row.title,content:[row.summary,row.content_text??htmlText(row.content_html)].filter(Boolean).join(' '),link:safeLink(row.url,url),publishedAt:row.date_published,updatedAt:row.date_modified,authors:(row.authors??(plain(row.author)?[row.author]:[])).map(a=>a.name),tags:row.tags,links:[...(row.attachments??[]).map(a=>safeLink(a.url,url)),...htmlLinks(row.content_html??'',url)]});
  });
}
export function sourceObservation(document,{format='auto'}={}){
  const {body,type='',url}=document;if(typeof body!=='string'||Buffer.byteLength(body)>2*1024*1024)fail('SOURCE_FEED_TOO_LARGE');
  const start=body.replace(/^\uFEFF/,'').trimStart(),isXml=/application\/(?:rss|atom)\+xml/i.test(type)||/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?(?:feed|rss)\b/.test(start),isJson=/application\/feed\+json/i.test(type)||/^\{/.test(start)&&/"version"\s*:\s*"https:\/\/jsonfeed\.org\/version\//.test(start);
  if(format==='document'||format==='auto'&&!isXml&&!isJson){
    const content=sourceText(body,type);return {format:'document',digest:digest([url,content]),content,items:null};
  }
  let rows,kind;
  if(isJson){let parsed;try{parsed=JSON.parse(start);}catch{fail('SOURCE_FEED_JSON_INVALID');}rows=jsonItems(parsed,url);kind='json-feed';}
  else {const root=parseFeedXml(start,url);kind=root.local==='feed'?'atom':'rss';rows=kind==='atom'?atomItems(root,url):rssItems(root,url);}
  if(rows.length>sourceItemPolicy.maxItems)fail('SOURCE_FEED_TOO_LARGE');
  const unique=new Map();for(const row of rows){const old=unique.get(row.key);if(old&&old.digest!==row.digest)fail('SOURCE_FEED_DUPLICATE_ID');unique.set(row.key,row);}
  const items=[...unique.values()].sort((a,b)=>a.key.localeCompare(b.key));
  return {format:kind,digest:digest(items.map(row=>[row.key,row.digest])),items};
}
