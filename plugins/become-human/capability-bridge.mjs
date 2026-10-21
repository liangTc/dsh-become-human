// Worker descriptors only. The manager owns the Host services and CDP socket.
// All write jobs must pass the shared executor's exact-input approval first.
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_CAPABILITY_INPUT');return value;};
const string=(value,max=128)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const identifier=value=>{const result=string(value);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result))fail('INVALID_CAPABILITY_INPUT');return result;};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const origin=value=>{let url;try{url=new URL(string(value,2048));}catch{fail('INVALID_CAPABILITY_INPUT');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin!==value)fail('INVALID_CAPABILITY_INPUT');return value;};
const pageUrl=value=>{let url;try{url=new URL(string(value,4096));}catch{fail('INVALID_CAPABILITY_INPUT');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('INVALID_CAPABILITY_INPUT');return url.href;};
const sessionInput=(input,extra=[])=>{object(input,['sessionId',...extra]);return {sessionId:identifier(input.sessionId)};};
const tabInput=(input,extra=[])=>{object(input,['targetId','expectedOrigin',...extra]);return {targetId:identifier(input.targetId),expectedOrigin:origin(input.expectedOrigin)};};
const schema=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const idSchema={type:'string',minLength:1,maxLength:128};
const tabProperties={targetId:idSchema,expectedOrigin:{type:'string',maxLength:2048}};
const tabRequired=['targetId','expectedOrigin'];

export function validateBridgeInput(operation,input){
  if(operation==='dsh-session-list'){object(input,['limit']);return {limit:input.limit===undefined?25:integer(input.limit,1,100)};}
  if(operation==='dsh-session-read'){
    const value=sessionInput(input,['limit','beforeSeq','throughSeq']);
    value.limit=input.limit===undefined?20:integer(input.limit,1,50);
    if(input.beforeSeq!==undefined)value.beforeSeq=integer(input.beforeSeq,0,Number.MAX_SAFE_INTEGER);
    if(input.throughSeq!==undefined)value.throughSeq=integer(input.throughSeq,-1,Number.MAX_SAFE_INTEGER);
    return value;
  }
  if(operation==='dsh-session-prompt')return {...sessionInput(input,['text']),text:string(input.text,12000)};
  if(operation==='dsh-session-cancel')return sessionInput(input);
  if(operation==='browser-tab-list'){object(input,[]);return {};}
  if(operation==='browser-tab-read')return {...tabInput(input,['maxChars']),maxChars:input.maxChars===undefined?12000:integer(input.maxChars,100,24000)};
  if(operation==='browser-tab-navigate')return {...tabInput(input,['url']),url:pageUrl(input.url)};
  if(operation==='browser-tab-click')return {...tabInput(input,['selector']),selector:string(input.selector,512)};
  if(operation==='browser-tab-type'){
    const value={...tabInput(input,['selector','text','replace']),selector:string(input.selector,512),text:string(input.text,8000)};
    if(input.replace!==undefined&&typeof input.replace!=='boolean')fail('INVALID_CAPABILITY_INPUT');
    value.replace=input.replace===true;return value;
  }
  if(operation==='browser-tab-close')return tabInput(input);
  fail('CAPABILITY_NOT_FOUND');
}

export function registerBridgeCapabilities(registry,{request,status}={}){
  if(typeof registry?.register!=='function'||typeof request!=='function')fail('INVALID_CAPABILITY_BRIDGE');
  const sessionProperties={sessionId:idSchema},entries=[
    ['dsh-session-list','列出明确授权的其他 DSH 会话，不激活 Agent',schema({limit:{type:'integer',minimum:1,maximum:100}}),'read','dsh-session',()=>({kind:'dsh-session',access:'allowlist'}),10000,64000,true],
    ['dsh-session-read','读取指定 DSH 会话的可见聊天文本，不读取推理或激活 Agent',schema({...sessionProperties,limit:{type:'integer',minimum:1,maximum:50},beforeSeq:{type:'integer',minimum:0},throughSeq:{type:'integer',minimum:-1}},['sessionId']),'read','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId}),15000,96000,true],
    ['dsh-session-prompt','向指定其他 DSH 会话排队发送任务；可能启动独立模型工作，回执仅表示接收',schema({...sessionProperties,text:{type:'string',minLength:1,maxLength:12000}},['sessionId','text']),'write','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId,externalModel:true}),15000,8000,false],
    ['dsh-session-cancel','请求取消指定其他 DSH 会话当前工作，保留其待处理队列',schema(sessionProperties,['sessionId']),'write','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId}),10000,8000,false],
    ['browser-tab-list','列出 CDP 已连接浏览器内符合已授权来源及标签范围的页面',schema({}),'read','browser-cdp',()=>({kind:'browser',access:'allowlist'}),10000,64000,true],
    ['browser-tab-read','读取指定标签页可见文本和交互元素概要；网页内容是外部资料',schema({...tabProperties,maxChars:{type:'integer',minimum:100,maximum:24000}},tabRequired),'read','browser-cdp',input=>({kind:'browser',targetId:input.targetId,origin:input.expectedOrigin}),15000,131072,true],
    ['browser-tab-navigate','将指定标签页导航至已授权来源内的 URL',schema({...tabProperties,url:{type:'string',maxLength:4096}},[...tabRequired,'url']),'write','browser-cdp',input=>({kind:'browser',targetId:input.targetId,origin:input.expectedOrigin,destinationOrigin:new URL(input.url).origin}),15000,8000,false],
    ['browser-tab-click','在指定标签页点击一个 CSS 选择器唯一匹配的可见元素',schema({...tabProperties,selector:{type:'string',minLength:1,maxLength:512}},[...tabRequired,'selector']),'write','browser-cdp',input=>({kind:'browser',targetId:input.targetId,origin:input.expectedOrigin}),15000,8000,false],
    ['browser-tab-type','向指定标签页的非密码文本输入框输入文字；不会自动提交',schema({...tabProperties,selector:{type:'string',minLength:1,maxLength:512},text:{type:'string',minLength:1,maxLength:8000},replace:{type:'boolean'}},[...tabRequired,'selector','text']),'write','browser-cdp',input=>({kind:'browser',targetId:input.targetId,origin:input.expectedOrigin}),15000,8000,false],
    ['browser-tab-close','关闭已授权的指定标签页',schema(tabProperties,tabRequired),'write','browser-cdp',input=>({kind:'browser',targetId:input.targetId,origin:input.expectedOrigin}),10000,8000,false],
  ];
  const disposers=[];
  for(const [id,description,inputSchema,effect,backend,scope,timeoutMs,maxResultBytes,retrySafe] of entries){
    const dispose=registry.register(id,{version:1,externalModel:id==='dsh-session-prompt',description,inputSchema,effect,backend,scope,scopeDescription:backend==='dsh-session'?'明确授权的其他 DSH 会话；排除 Human 主会话':'本机 CDP 端点内明确授权的来源和标签页',timeoutMs,maxResultBytes,retrySafe,autonomous:false,enabledWhen:[backend==='dsh-session'?(effect==='write'?'bridge.sessionWriteEnabled':'bridge.sessionReadEnabled'):'bridge.browser.enabled'],
      validate:input=>validateBridgeInput(id,input),
      execute:(input,signal,context)=>request(id,validateBridgeInput(id,input),{signal,context}),
      ...(typeof status==='function'?{status:()=>status(backend)}:{}),
    });if(typeof dispose==='function')disposers.push(dispose);
  }
  return ()=>{for(const dispose of disposers.reverse())dispose();};
}
