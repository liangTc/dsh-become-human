// CDP adapter for an explicitly configured local debugging endpoint. No browser
// is started or discovered here, and callers cannot submit JavaScript/CDP names.
const error=code=>Object.assign(new Error(code),{code});
const fail=code=>{throw error(code);};
const only=(input,keys,code='INVALID_CAPABILITY_INPUT')=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail(code);};
const text=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const identifier=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))fail('INVALID_CAPABILITY_INPUT');return value;};
const loopback=hostname=>['127.0.0.1','localhost','[::1]'].includes(hostname);
const httpUrl=value=>{let url;try{url=new URL(text(value,4096));}catch{fail('INVALID_CAPABILITY_INPUT');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('INVALID_CAPABILITY_INPUT');return url;};
const exactOrigin=value=>{const url=httpUrl(value);if(value!==url.origin)fail('INVALID_CAPABILITY_SETTINGS');return url.origin;};
const unknown=cause=>Object.assign(error('CAPABILITY_OUTCOME_UNKNOWN'),{cause});

// Constant functions run in an isolated world bound to one already-resolved
// main-document element. Input data is passed as CDP values, never as code.
const FIXED_INPUT_FUNCTION=`function(text,replace,expectedOrigin){
  const valid=()=>location.origin===expectedOrigin&&this.ownerDocument===document&&this.isConnected;
  const editable=()=>this.tagName==='TEXTAREA'||this.tagName==='INPUT'&&['','text','search','email','url','tel','number'].includes((this.getAttribute('type')||'').toLowerCase())||this.isContentEditable;
  if(!valid()||!editable()||this.disabled||this.readOnly)throw new Error('BROWSER_ELEMENT_CHANGED');
  HTMLElement.prototype.focus.call(this,{preventScroll:true});
  if(!valid()||!editable()||this.disabled||this.readOnly||document.activeElement!==this)throw new Error('BROWSER_FOCUS_CHANGED');
  const field=this.tagName==='INPUT'||this.tagName==='TEXTAREA';
  const previous=field?this.value:this.textContent||'',next=replace?text:previous+text;
  if(field){const prototype=this.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(this,next);}
  else this.textContent=next;
  this.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:text}));
  return {applied:true,valueMatches:valid()&&(field?this.value:this.textContent)===next,characters:text.length};
}`;
const FIXED_CLICK_FUNCTION=`function(expectedOrigin){
  if(location.origin!==expectedOrigin||this.ownerDocument!==document||!this.isConnected||!(this instanceof HTMLElement)||['IFRAME','FRAME','OBJECT','EMBED'].includes(this.tagName)||this.tagName==='INPUT'&&(this.getAttribute('type')||'').toLowerCase()==='file')throw new Error('BROWSER_ELEMENT_CHANGED');
  const rect=this.getBoundingClientRect(),x=Math.min(innerWidth-1,Math.max(0,rect.x+rect.width/2)),y=Math.min(innerHeight-1,Math.max(0,rect.y+rect.height/2));
  const hit=document.elementFromPoint(x,y);
  if(rect.width<=0||rect.height<=0||!hit||['IFRAME','FRAME','OBJECT','EMBED'].includes(hit.tagName)||hit!==this&&!this.contains(hit))throw new Error('BROWSER_ELEMENT_OBSCURED');
  HTMLElement.prototype.click.call(this);return {dispatched:true};
}`;

export function normalizeBrowserSettings(input={}){
  only(input,['enabled','endpoint','allowedOrigins','allowedTargetIds'],'INVALID_CAPABILITY_SETTINGS');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fail('INVALID_CAPABILITY_SETTINGS');
  const endpoint=httpUrl(input.endpoint??'http://127.0.0.1:9222');
  if(endpoint.protocol!=='http:'||!loopback(endpoint.hostname)||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||!endpoint.port)fail('INVALID_CAPABILITY_SETTINGS');
  const origins=input.allowedOrigins??[],targets=input.allowedTargetIds??[];
  if(!Array.isArray(origins)||origins.length>32||!Array.isArray(targets)||targets.length>64)fail('INVALID_CAPABILITY_SETTINGS');
  return {enabled:input.enabled===true,endpoint:endpoint.origin,allowedOrigins:[...new Set(origins.map(exactOrigin))].sort(),allowedTargetIds:[...new Set(targets.map(identifier))].sort()};
}

async function readJson(url,signal){
  const response=await fetch(url,{signal,redirect:'error',headers:{Accept:'application/json'},cache:'no-store'});
  if(!response.ok)fail('BROWSER_CDP_HTTP_FAILED');const reader=response.body?.getReader();let bytes=0;const chunks=[];
  try{if(reader)while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>1048576)fail('BROWSER_CDP_RESULT_TOO_LARGE');chunks.push(Buffer.from(part.value));}}
  finally{if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('BROWSER_CDP_INVALID_RESPONSE');}return value;
}

class CdpConnection {
  constructor(url,signal){
    this.signal=signal;this.socket=new WebSocket(url);this.sequence=0;this.pending=new Map();this.listeners=new Set();this.mutated=false;this.closed=false;
    this.ready=new Promise((resolve,reject)=>{
      this.socket.addEventListener('open',()=>{if(signal.aborted){reject(signal.reason??error('CAPABILITY_CANCELLED'));this.close();}else resolve();},{once:true});
      this.socket.addEventListener('error',()=>reject(error('BROWSER_CDP_CONNECTION_FAILED')),{once:true});
      this.socket.addEventListener('close',()=>reject(error('BROWSER_CDP_CONNECTION_CLOSED')),{once:true});
    });
    this.socket.addEventListener('message',event=>{try{
      if(typeof event.data!=='string'||Buffer.byteLength(event.data)>4194304){this.terminate(error('BROWSER_CDP_RESULT_TOO_LARGE'));return;}
      const message=JSON.parse(event.data);if(message.id!==undefined){const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);if(message.error)pending.reject(error('BROWSER_CDP_COMMAND_FAILED'));else pending.resolve(message.result??{});}
      else for(const listener of this.listeners)listener(message);
    }catch{this.terminate(error('BROWSER_CDP_INVALID_RESPONSE'));}});
    this.socket.addEventListener('close',()=>this.terminate(error('BROWSER_CDP_CONNECTION_CLOSED')));
    this.abort=()=>this.terminate(signal.reason??error('CAPABILITY_CANCELLED'));signal.addEventListener('abort',this.abort,{once:true});if(signal.aborted)this.abort();
  }
  async send(method,params={},mutating=false){
    await this.ready;this.signal.throwIfAborted();if(this.closed||this.socket.readyState!==WebSocket.OPEN)fail('BROWSER_CDP_CONNECTION_CLOSED');
    const id=++this.sequence;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(error('BROWSER_CDP_TIMEOUT'));},6000);this.pending.set(id,{resolve,reject,timer});
      try{if(mutating)this.mutated=true;this.socket.send(JSON.stringify({id,method,params}));}catch(cause){this.pending.delete(id);clearTimeout(timer);reject(cause);}
    });
  }
  terminate(cause){if(this.closed)return;this.closed=true;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(cause);}this.pending.clear();this.socket.close();}
  close(){this.signal.removeEventListener('abort',this.abort);this.listeners.clear();this.terminate(error('BROWSER_CDP_CONNECTION_CLOSED'));}
}

export function createBrowserCapabilities(){
  let settings=normalizeBrowserSettings(),fingerprint=JSON.stringify(settings),revision=null,closed=false,lastConnection={state:'not-connected',at:null};const active=new Set();
  const allowedOrigin=url=>{try{return settings.allowedOrigins.includes(new URL(url).origin);}catch{return false;}};
  const allowedTarget=id=>!settings.allowedTargetIds.length||settings.allowedTargetIds.includes(id);
  const check=(signal,expected)=>{signal.throwIfAborted();if(closed)fail('CAPABILITY_BRIDGE_CLOSED');if(!settings.enabled)fail('CAPABILITY_DISABLED');if(expected!==fingerprint)fail('CAPABILITY_POLICY_CHANGED');};
  const rawTabs=async(signal,expected)=>{check(signal,expected);const rows=await readJson(settings.endpoint+'/json/list',signal);check(signal,expected);if(!Array.isArray(rows))fail('BROWSER_CDP_INVALID_RESPONSE');lastConnection={state:'connected',at:Date.now()};return rows;};
  const tabs=async(signal,expected)=>(await rawTabs(signal,expected)).filter(row=>row?.type==='page'&&typeof row.id==='string'&&allowedTarget(row.id)&&allowedOrigin(row.url));
  const getTab=async(input,signal,expected)=>{const rows=await tabs(signal,expected),row=rows.find(tab=>tab.id===input.targetId);if(!row)fail('CAPABILITY_SCOPE_DENIED');if(new URL(row.url).origin!==input.expectedOrigin)fail('BROWSER_TARGET_ORIGIN_CHANGED');return row;};
  const websocketUrl=tab=>{
    let url;try{url=new URL(tab.webSocketDebuggerUrl);}catch{fail('BROWSER_CDP_INVALID_RESPONSE');}
    const endpoint=new URL(settings.endpoint);if(url.protocol!=='ws:'||!loopback(url.hostname)||url.port!==endpoint.port||url.username||url.password||url.search||url.hash||url.pathname!=='/devtools/page/'+tab.id)fail('BROWSER_CDP_ENDPOINT_MISMATCH');return url.href;
  };
  const inputFor=(operation,input)=>{
    if(operation==='browser-tab-list'){only(input,[]);return {};}
    const extra=operation==='browser-tab-read'?['maxChars']:operation==='browser-tab-navigate'?['url']:operation==='browser-tab-click'?['selector']:operation==='browser-tab-type'?['selector','text','replace']:[];
    only(input,['targetId','expectedOrigin',...extra]);const value={targetId:identifier(input.targetId),expectedOrigin:exactOrigin(input.expectedOrigin)};
    if(operation==='browser-tab-read'){value.maxChars=input.maxChars??12000;if(!Number.isSafeInteger(value.maxChars)||value.maxChars<100||value.maxChars>24000)fail('INVALID_CAPABILITY_INPUT');}
    if(operation==='browser-tab-navigate')value.url=httpUrl(input.url).href;
    if(['browser-tab-click','browser-tab-type'].includes(operation))value.selector=text(input.selector,512);
    if(operation==='browser-tab-type'){value.text=text(input.text,8000);if(input.replace!==undefined&&typeof input.replace!=='boolean')fail('INVALID_CAPABILITY_INPUT');value.replace=input.replace===true;}
    return value;
  };
  async function currentFrame(client,input,signal,expected,{navigation=false}={}){
    check(signal,expected);const {frameTree}=await client.send('Page.getFrameTree');check(signal,expected);const url=frameTree?.frame?.url;
    if(!allowedOrigin(url))fail('CAPABILITY_SCOPE_DENIED');if(!navigation&&new URL(url).origin!==input.expectedOrigin)fail('BROWSER_TARGET_ORIGIN_CHANGED');return frameTree.frame;
  }
  async function protectNavigation(client,signal,expected){
    client.listeners.add(message=>{
      if(message.method!=='Fetch.requestPaused')return;
      const request=message.params,permitted=allowedOrigin(request?.request?.url);
      if(!permitted)client.blockedNavigation=true;
      client.send(permitted?'Fetch.continueRequest':'Fetch.failRequest',permitted?{requestId:request.requestId}:{requestId:request.requestId,errorReason:'BlockedByClient'}).catch(()=>{});
    });
    await client.send('Fetch.enable',{patterns:[{resourceType:'Document',requestStage:'Request'}]});check(signal,expected);
  }
  async function element(client,selector){
    const {root}=await client.send('DOM.getDocument',{depth:0,pierce:false});const result=await client.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector});
    if(result.nodeIds?.length!==1)fail(result.nodeIds?.length?'BROWSER_ELEMENT_AMBIGUOUS':'BROWSER_ELEMENT_NOT_FOUND');
    const nodeId=result.nodeIds[0],{node}=await client.send('DOM.describeNode',{nodeId,depth:5,pierce:false});return {nodeId,node};
  }
  const attributes=node=>{const output={};for(let i=0;i<(node?.attributes?.length??0);i+=2)output[node.attributes[i]]=node.attributes[i+1];return output;};
  async function isolatedElement(client,input,found,signal,expected){
    const frame=await currentFrame(client,input,signal,expected),again=await element(client,input.selector);
    if(again.node?.backendNodeId!==found.node?.backendNodeId||['IFRAME','FRAME','OBJECT','EMBED'].includes(again.node?.nodeName))fail('BROWSER_ELEMENT_CHANGED');
    const world=await client.send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'become-human-fixed-dom'});
    const {object}=await client.send('DOM.resolveNode',{nodeId:again.nodeId,executionContextId:world.executionContextId});
    if(typeof object?.objectId!=='string')fail('BROWSER_ELEMENT_CHANGED');
    await currentFrame(client,input,signal,expected);return object.objectId;
  }
  async function pageRead(client,input,signal,expected,tab){
    await currentFrame(client,input,signal,expected);const snapshot=await client.send('DOMSnapshot.captureSnapshot',{computedStyles:[],includeDOMRects:false,includePaintOrder:false});await currentFrame(client,input,signal,expected);
    const strings=snapshot.strings??[],doc=snapshot.documents?.[0];if(!doc||!allowedOrigin(strings[doc.documentURL])||new URL(strings[doc.documentURL]).origin!==input.expectedOrigin)fail('BROWSER_TARGET_ORIGIN_CHANGED');
    const parts=(doc.layout?.text??[]).map(index=>strings[index]).filter(value=>typeof value==='string'&&value.trim());
    const full=parts.join('\n'),body=full.slice(0,input.maxChars),nodes=doc.nodes??{},visible=new Set(doc.layout?.nodeIndex??[]),controls=[];let controlChars=0;
    for(let i=0;i<(nodes.nodeName?.length??0)&&controls.length<60;i++){
      const name=strings[nodes.nodeName[i]];if(!visible.has(i)||!['A','BUTTON','INPUT','TEXTAREA','SELECT'].includes(name))continue;
      const attrs={};for(let j=0;j<(nodes.attributes?.[i]?.length??0);j+=2)attrs[strings[nodes.attributes[i][j]]]=strings[nodes.attributes[i][j+1]];
      if(attrs.type==='password'||attrs.type==='hidden')continue;
      const control={tag:name.toLowerCase(),...Object.fromEntries(['id','name','type','role','aria-label','placeholder','href'].filter(key=>typeof attrs[key]==='string').map(key=>[key,attrs[key].slice(0,256)]))};controlChars+=JSON.stringify(control).length;if(controlChars>8000)break;controls.push(control);
    }
    return {targetId:input.targetId,url:tab.url,title:String(tab.title??'').slice(0,512),text:body,controls,truncated:full.length>body.length,source:'browser-page',untrustedContent:true,observedAt:Date.now()};
  }
  async function pageWrite(operation,client,input,signal,expected){
    await currentFrame(client,input,signal,expected);await protectNavigation(client,signal,expected);
    const receipt={operation,targetId:input.targetId,origin:input.expectedOrigin,at:Date.now()};
    if(operation==='browser-tab-navigate'){
      if(!allowedOrigin(input.url))fail('CAPABILITY_SCOPE_DENIED');await currentFrame(client,input,signal,expected);
      const result=await client.send('Page.navigate',{url:input.url},true);if(result.errorText)throw unknown();
      const frame=await currentFrame(client,input,signal,expected,{navigation:true});if(client.blockedNavigation)throw unknown();
      return {status:'navigation-accepted',receipt,url:frame.url,requestedUrl:input.url,documentLoaded:false,meaning:'浏览器已接收导航并核对当前来源；未宣称页面加载完成。'};
    }
    if(operation==='browser-tab-close'){
      await currentFrame(client,input,signal,expected);await client.send('Page.close',{},true);
      const rows=await rawTabs(signal,expected);if(rows.some(row=>row.id===input.targetId))throw unknown();return {status:'closed',receipt,observedClosed:true};
    }
    const found=await element(client,input.selector);await currentFrame(client,input,signal,expected);
    if(['IFRAME','FRAME','OBJECT','EMBED'].includes(found.node?.nodeName))fail('BROWSER_FRAME_ELEMENT_FORBIDDEN');
    if(operation==='browser-tab-type'){
      const attrs=attributes(found.node),name=found.node?.nodeName;
      const editable=name==='TEXTAREA'||name==='INPUT'&&['','text','search','email','url','tel','number'].includes((attrs.type??'').toLowerCase())||attrs.contenteditable===''||attrs.contenteditable==='true';
      if(!editable||attrs.disabled!==undefined||attrs.readonly!==undefined)fail('BROWSER_ELEMENT_NOT_EDITABLE');
      const objectId=await isolatedElement(client,input,found,signal,expected);
      const result=await client.send('Runtime.callFunctionOn',{objectId,functionDeclaration:FIXED_INPUT_FUNCTION,arguments:[{value:input.text},{value:input.replace},{value:input.expectedOrigin}],returnByValue:true,awaitPromise:false},true);
      await currentFrame(client,input,signal,expected);if(client.blockedNavigation||result.exceptionDetails||result.result?.value?.applied!==true||result.result?.value?.valueMatches!==true)throw unknown();
      return {status:'input-applied',receipt,selector:input.selector,characters:input.text.length,replaced:input.replace,submitCommandIssued:false,domValueVerified:true,meaning:'已核对主文档目标与焦点并输入，校验了 DOM 值；未发送提交命令，不代表网站业务已保存。'};
    }
    if(operation==='browser-tab-click'){
      await client.send('DOM.scrollIntoViewIfNeeded',{nodeId:found.nodeId},true);const result=await client.send('DOM.getContentQuads',{nodeId:found.nodeId});
      const quad=result.quads?.find(points=>Array.isArray(points)&&points.length===8&&points.every(Number.isFinite));if(!quad)throw unknown();
      const x=(quad[0]+quad[2]+quad[4]+quad[6])/4,y=(quad[1]+quad[3]+quad[5]+quad[7])/4;if(x<0||y<0)throw unknown();
      const frame=await currentFrame(client,input,signal,expected),hit=await client.send('DOM.getNodeForLocation',{x:Math.round(x),y:Math.round(y),includeUserAgentShadowDOM:false,ignorePointerEventsNone:false});
      if(hit.frameId!==frame.id)throw unknown();
      const descendants=new Set(),collect=node=>{if(!node||descendants.size>2048)return;descendants.add(node.backendNodeId);for(const child of node.children??[])collect(child);};collect(found.node);
      if(!descendants.has(hit.backendNodeId))throw unknown();
      const objectId=await isolatedElement(client,input,found,signal,expected);
      const clicked=await client.send('Runtime.callFunctionOn',{objectId,functionDeclaration:FIXED_CLICK_FUNCTION,arguments:[{value:input.expectedOrigin}],returnByValue:true,awaitPromise:false},true);
      await currentFrame(client,input,signal,expected,{navigation:true});if(client.blockedNavigation||clicked.exceptionDetails||clicked.result?.value?.dispatched!==true)throw unknown();
      return {status:'click-dispatched',receipt,selector:input.selector,dispatchMethod:'fixed-dom-click',trustedUserEvent:false,outcomeVerified:false,meaning:'对已核对的主文档目标派发了 DOM 点击；不是系统级鼠标事件，网站业务结果需后续读取核对。'};
    }
    fail('CAPABILITY_NOT_FOUND');
  }
  return {
    configure(input,{revision:nextRevision}={}){
      if(closed)fail('CAPABILITY_BRIDGE_CLOSED');const next=normalizeBrowserSettings(input),nextFingerprint=JSON.stringify(next);
      if(nextFingerprint!==fingerprint||(nextRevision!==undefined&&nextRevision!==revision)){for(const aborter of active)aborter.abort(error('CAPABILITY_POLICY_CHANGED'));settings=next;fingerprint=nextFingerprint;revision=nextRevision??revision;lastConnection={state:'not-connected',at:null};}return this.status();
    },
    status(){return {...settings,allowedOrigins:[...settings.allowedOrigins],allowedTargetIds:[...settings.allowedTargetIds],connection:{...lastConnection},closed,protocol:'cdp-loopback',arbitraryJavaScript:false,startsBrowser:false};},
    async handle({operation,input}={},signal=new AbortController().signal){
      if(!['browser-tab-list','browser-tab-read','browser-tab-navigate','browser-tab-click','browser-tab-type','browser-tab-close'].includes(operation))fail('CAPABILITY_NOT_FOUND');
      const normalized=inputFor(operation,input),aborter=new AbortController(),abort=()=>aborter.abort(signal.reason??error('CAPABILITY_CANCELLED')),timeout=setTimeout(()=>aborter.abort(error('BROWSER_CDP_TIMEOUT')),14000);active.add(aborter);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const expected=fingerprint;let client;
      try{
        check(aborter.signal,expected);if(operation==='browser-tab-list'){const rows=await tabs(aborter.signal,expected),items=[];let used=0;for(const row of rows.slice(0,100)){const item={targetId:row.id,title:String(row.title??'').slice(0,256),url:String(row.url).slice(0,2048),origin:new URL(row.url).origin};used+=JSON.stringify(item).length;if(used>12000)break;items.push(item);}return {items,hasMore:rows.length>items.length};}
        if(!settings.allowedOrigins.includes(normalized.expectedOrigin)||!allowedTarget(normalized.targetId))fail('CAPABILITY_SCOPE_DENIED');
        const tab=await getTab(normalized,aborter.signal,expected);client=new CdpConnection(websocketUrl(tab),aborter.signal);await client.ready;await client.send('Page.enable');check(aborter.signal,expected);
        if(operation==='browser-tab-read')return await pageRead(client,normalized,aborter.signal,expected,tab);
        return await pageWrite(operation,client,normalized,aborter.signal,expected);
      }catch(cause){if(client?.mutated&&cause?.code!=='CAPABILITY_OUTCOME_UNKNOWN')throw unknown(cause);lastConnection={state:cause?.code==='CAPABILITY_SCOPE_DENIED'?'connected':'operation-failed',at:Date.now(),code:/^[A-Z0-9_]{3,80}$/.test(cause?.code??'')?cause.code:'BROWSER_CDP_FAILED'};throw cause;}
      finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);active.delete(aborter);client?.close();}
    },
    async close(){if(closed)return;closed=true;for(const aborter of active)aborter.abort(error('CAPABILITY_BRIDGE_CLOSED'));active.clear();},
  };
}
