// Worker descriptors only. The manager owns the Host session services.
// All write jobs must pass the shared executor's exact-input approval first.
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('INVALID_CAPABILITY_INPUT');return value;};
const string=(value,max=128)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const identifier=value=>{const result=string(value);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result))fail('INVALID_CAPABILITY_INPUT');return result;};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('INVALID_CAPABILITY_INPUT');return value;};
const sessionInput=(input,extra=[])=>{object(input,['sessionId',...extra]);return {sessionId:identifier(input.sessionId)};};
const schema=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const idSchema={type:'string',minLength:1,maxLength:128};

export function validateBridgeInput(operation,input){
  if(operation==='dsh-session-list'){object(input,['limit','offset']);return {limit:input.limit===undefined?25:integer(input.limit,1,100),...(input.offset===undefined?{}:{offset:integer(input.offset,0,100000)})};}
  if(operation==='dsh-session-read'){
    const value=sessionInput(input,['limit','beforeSeq','throughSeq']);
    value.limit=input.limit===undefined?20:integer(input.limit,1,50);
    if(input.beforeSeq!==undefined)value.beforeSeq=integer(input.beforeSeq,0,Number.MAX_SAFE_INTEGER);
    if(input.throughSeq!==undefined)value.throughSeq=integer(input.throughSeq,-1,Number.MAX_SAFE_INTEGER);
    return value;
  }
  if(operation==='dsh-session-prompt')return {...sessionInput(input,['text']),text:string(input.text,12000)};
  if(operation==='dsh-session-cancel')return {...sessionInput(input,['expectedTurn','expectedTurnStartSeq']),expectedTurn:integer(input.expectedTurn,1,Number.MAX_SAFE_INTEGER),expectedTurnStartSeq:integer(input.expectedTurnStartSeq,0,Number.MAX_SAFE_INTEGER)};
  fail('CAPABILITY_NOT_FOUND');
}

export function registerBridgeCapabilities(registry,{request,status}={}){
  if(typeof registry?.register!=='function'||typeof request!=='function')fail('INVALID_CAPABILITY_BRIDGE');
  const sessionProperties={sessionId:idSchema},entries=[
    ['dsh-session-list','列出读取授权范围内的其他 DSH 会话，支持指定会话或 Host 可见的全部普通会话，不激活 Agent',schema({limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:100000}}),'read','dsh-session',()=>({kind:'dsh-session',access:'configured-visible-sessions'}),10000,64000,true],
    ['dsh-session-read','读取指定 DSH 会话的可见聊天文本，不读取推理或激活 Agent',schema({...sessionProperties,limit:{type:'integer',minimum:1,maximum:50},beforeSeq:{type:'integer',minimum:0},throughSeq:{type:'integer',minimum:-1}},['sessionId']),'read','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId}),15000,96000,true],
    ['dsh-session-prompt','向指定其他 DSH 会话排队发送任务；可能启动独立模型工作，回执仅表示接收',schema({...sessionProperties,text:{type:'string',minLength:1,maxLength:12000}},['sessionId','text']),'write','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId,externalModel:true}),15000,8000,false],
    ['dsh-session-cancel','取消读取结果 activeTurn 指定的那一轮工作；任务已切换则拒绝，保留待处理队列',schema({...sessionProperties,expectedTurn:{type:'integer',minimum:1},expectedTurnStartSeq:{type:'integer',minimum:0}},['sessionId','expectedTurn','expectedTurnStartSeq']),'write','dsh-session',input=>({kind:'dsh-session',sessionId:input.sessionId,turn:input.expectedTurn,turnStartSeq:input.expectedTurnStartSeq}),10000,8000,false],
  ];
  const disposers=[];
  for(const [id,description,inputSchema,effect,backend,scope,timeoutMs,maxResultBytes,retrySafe] of entries){
    const dispose=registry.register(id,{version:id==='dsh-session-cancel'?2:1,externalModel:id==='dsh-session-prompt',description,inputSchema,effect,backend,scope,scopeDescription:'分别按读取/使用授权范围校验 Host 当前可见的普通会话；排除 Human 主会话及子 Agent，写操作仍逐笔审批',timeoutMs,maxResultBytes,retrySafe,autonomous:false,enabledWhen:[effect==='write'?'bridge.sessionWriteEnabled':'bridge.sessionReadEnabled'],
      validate:input=>validateBridgeInput(id,input),
      execute:(input,signal,context)=>request(id,validateBridgeInput(id,input),{signal,context}),
      ...(typeof status==='function'?{status:()=>status(backend)}:{}),
    });if(typeof dispose==='function')disposers.push(dispose);
  }
  return ()=>{for(const dispose of disposers.reverse())dispose();};
}
