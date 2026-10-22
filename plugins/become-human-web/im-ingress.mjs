import {randomBytes,createHash} from 'node:crypto';
import {IM_CHANNELS} from './im-catalog.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const channelKey=(channel,botId)=>'im-'+hash(channel+':'+botId).slice(0,24);
const canonical=channel=>channel==='wecomApp'?'wecom-app':channel;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class SingleImIngress {
  constructor(remote,runtime){
    this.remote=remote;this.runtime=runtime;this.service=null;this.activationStates=new Map();this.closed=false;this.directTail=Promise.resolve();this.ingressTail=Promise.resolve();
    remote.db.exec('CREATE TABLE IF NOT EXISTS im_pair(code TEXT PRIMARY KEY,channel TEXT,expires INTEGER,used INTEGER);');
    const wrap=operation=>async({rpcId,payload={}})=>{try{return {rpcId,result:{ok:true,value:await operation(payload)}};}catch(error){return {rpcId,result:{ok:false,error:{code:error.code??'SINGLE_SESSION_ONLY',message:'该操作由自主 Agent 的统一会话管理。',details:{}}}};}};
    const listed=async()=>{const s=await runtime.state();return {items:[{sessionId:s.sessionId,running:s.agentBusy,title:'自主 Agent',workspaceId:'become-human',cwd:process.cwd()}]};};
    const catalog=async()=>{const s=await runtime.state();return {groups:[{id:s.provider,name:s.provider,models:[{id:s.model,name:s.model}]}],failures:[]};};
    const denied=()=>{throw new Error('SINGLE_SESSION_MANAGED_CENTRALLY');};
    this.apiProxy={host:{describe:wrap(async()=>{await runtime.state();return {ready:true,transport:'single-autonomous-runtime'};})},workspace:{list:wrap(async()=>({items:[{workspaceId:'become-human',path:process.cwd()}]})),entries:wrap(listed),create:wrap(denied)},sessions:{list:wrap(listed),create:wrap(async()=>({sessionId:await this.currentSessionId()})),models:wrap(catalog),selectModel:wrap(denied),permissions:wrap(async()=>({items:[]})),cancel:wrap(async()=>remote.controlRuntime({op:'pause'})),rename:wrap(denied)},llm:{models:wrap(catalog)},watchMux:async({signal,onOpen})=>{onOpen?.();while(!signal?.aborted&&!this.closed)await sleep(500);},respond:async()=>({accepted:false})};
    this.apiProxy.events={mux:async function*(_request,signal){while(!signal.aborted)await sleep(300);}};
    this.apiProxy.workspace.sessions=wrap(async()=>{const s=await runtime.state();return {sessions:[{sessionId:s.sessionId,running:s.agentBusy,title:'自主 Agent'}]};});
    remote.register('im-unified',{validate:async config=>{if(!config.botId||!config.targetId||!config.ownerId||!config.fingerprint)throw new Error('IM_PAIR_REQUIRED');},verify:async config=>{const a=await this.service?.describeBot(config.botId);if(a?.account?.fingerprint!==config.fingerprint)throw new Error('IM_ACCOUNT_CHANGED');return {privateOwner:true};},authorizeInbound:async(config,e)=>e.privateChat===true&&e.senderId===config.ownerId,send:async(config,text)=>{
      if(!this.service)throw new Error('IM_SERVICE_UNAVAILABLE');return this.service.sendChecked(config.botId,config.targetId,text,{expectedFingerprint:config.fingerprint,expectedTargetDigest:config.targetDigest,signal:AbortSignal.timeout(15000)});
    }});
  }
  forBot(botId){const self=this;return new Proxy(this,{get(target,key){if(key==='accept')return input=>self.accept({...input,botId:input.botId??botId});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}
  bindService(service){this.service=service;}
  async checkAccount(botId){const account=await this.service?.describeBot(botId);return {channel:account?.channel,connected:account?.connected===true,fingerprintValid:/^[a-f0-9]{64}$/.test(account?.account?.fingerprint??''),capabilities:account?.capabilities??[]};}
  activation(channel,state){this.activationStates.set(canonical(channel),state);}
  async currentSessionId(){return (await this.runtime.state()).sessionId;}
  binding(channel,botId){return this.remote.channel(channelKey(canonical(channel),botId));}
  beginPair(channel){if(!IM_CHANNELS.some(c=>c.id===channel&&!c.connector))throw new Error('INVALID_CHANNEL');const code=randomBytes(8).toString('hex').toUpperCase();this.remote.db.prepare('DELETE FROM im_pair').run();this.remote.db.prepare('INSERT INTO im_pair VALUES(?,?,?,0)').run(hash(code),channel,Date.now()+120000);return {code,expires:Date.now()+120000,channel};}
  admission(channel,botId,{conversationType,senderIds,text='',hasImages,hasFiles}={}){
    channel=canonical(channel);if(conversationType!=='direct')return {allowed:false,reason:'single-private-owner-only'};
    const ids=Array.isArray(senderIds)?senderIds:[senderIds];const b=this.binding(channel,botId);if(b?.enabled&&ids.includes(b.config.ownerId))return {allowed:true,reason:'single-owner'};
    const match=/^\/pair\s+([A-F0-9]{16})$/i.exec(text.trim());const nonce=match?this.remote.db.prepare('SELECT * FROM im_pair WHERE code=?').get(hash(match[1].toUpperCase())):null;
    return {allowed:!!(nonce&&!nonce.used&&nonce.channel===channel&&nonce.expires>Date.now()&&!hasImages&&!hasFiles),reason:'single-owner-pair-required'};
  }
  policy(channel,botId){const b=this.binding(channel,botId),scope={mode:'allowlist',open:{defaultCanExecuteCommands:false,commandPermissionOverrides:[]},allowlist:{users:b?[{id:b.config.ownerId,canExecuteCommands:true}]:[]}};return {version:1,direct:scope,group:{...scope,allowlist:{users:[]}}};}
  target(channel,message){const sender=String(message.senderId),chat=String(message.conversationId);switch(channel){case'weixin':return {kind:'user',route:{toUserId:sender}};case'feishu':return {kind:'user',route:{openId:sender}};case'dingtalk':return {kind:'user',route:{userId:sender}};case'wecom':case'wecom-app':return {kind:'user',route:{chatId:chat}};case'qq':return {kind:'user',route:{userOpenId:sender}};case'slack':return {kind:'conversation',route:{channelId:chat}};case'telegram':return {kind:'chat',route:{chatId:chat}};case'discord':return {kind:'channel',route:{channelId:chat}};case'whatsapp':return {kind:'user',route:{jid:sender}};case'imessage':return {kind:'user',route:{chatGuid:message.replyTarget?.chatGuid??chat}};case'email':return {kind:'user',route:{address:sender.toLowerCase()}};case'matrix':return {kind:'dm',route:{userId:sender}};default:throw new Error('INVALID_CHANNEL');}}
  async pair(channel,botId,message,code){
    const nonce=this.remote.db.prepare('UPDATE im_pair SET used=1 WHERE code=? AND used=0 AND channel=? AND expires>? RETURNING code').get(hash(code.toUpperCase()),channel,Date.now());if(!nonce)throw new Error('IM_PAIR_EXPIRED');
    if(!this.service)throw new Error('IM_SERVICE_UNAVAILABLE');const account=await this.service.describeBot(botId);if(!account?.account?.fingerprint)throw new Error('IM_ACCOUNT_UNVERIFIED');
    const target=this.target(channel,message),key=channelKey(channel,botId),targetId='private-'+hash(key+':'+message.senderId).slice(0,20);
    const existing=(await this.service.listTargets(botId)).targets?.find(t=>t.targetId===targetId);if(existing&&(existing.kind!==target.kind||JSON.stringify(existing.route)!==JSON.stringify(target.route)))throw new Error('IM_TARGET_CHANGED');if(!existing)await this.service.createTarget(botId,{targetId,name:'自主 Agent 本人',...target});
    const digest=hash(JSON.stringify({kind:target.kind,route:Object.fromEntries(Object.entries(target.route).sort(([a],[b])=>a<b?-1:a>b?1:0))}));
    await this.remote.save({id:key,kind:'im-unified',config:{platform:channel,botId,targetId,ownerId:String(message.senderId),fingerprint:account.account.fingerprint,targetDigest:digest}});
    await this.remote.enable(key,true);return key;
  }
  accept(input){this.ingressTail=this.ingressTail.catch(()=>{}).then(()=>this.acceptOne(input));return this.ingressTail;}
  async acceptOne({channel,botId,message,state,reply,signal,beforePair}){
    channel=canonical(channel);if(signal?.aborted||this.closed||!botId||!message?.messageId||!message.senderId||message.senderIsBot||message.kind==='group')return;
    if(state?.hasSeen?.(message.messageId))return;
    const text=typeof message.content==='string'?message.content.trim():typeof message.text==='string'?message.text.trim():'';
    const pair=/^\/pair\s+([A-F0-9]{16})$/i.exec(text);
    if(pair){if(!this.admission(channel,botId,{conversationType:'direct',senderIds:message.senderId,text}).allowed)return;await beforePair?.();try{await this.pair(channel,botId,message,pair[1]);this.remote.preference('pair-error:'+channel,null);await reply('已绑定本自主 Agent 的唯一会话。Web 与当前手机渠道共用记忆和预算；旧渠道绑定已替换。');}catch(error){this.remote.preference('pair-error:'+channel,{code:/^[A-Za-z0-9_-]{2,64}$/.test(error.code??error.message)?error.code??error.message:'IM_PAIR_FAILED',time:Date.now()});await reply('配对未完成，请在 Web 查看渠道错误并重新生成配对码。');}await state?.markSeen?.(message.messageId);return;}
    const key=channelKey(channel,botId),b=this.remote.channel(key);if(!b?.enabled||b.config.ownerId!==String(message.senderId))return;
    const account=await this.service.describeBot(botId);if(account?.account?.fingerprint!==b.config.fingerprint)throw new Error('IM_ACCOUNT_CHANGED');
    const hasMedia=message.hasMedia||message.images?.length||message.files?.length;
    if(!text&&!hasMedia)return;
    // Only the verified current owner can refresh conversation capability.
    // A picture/file is still a genuine interaction even when its contents are
    // outside the current text-only thinking contract.
    await beforePair?.();
    if(hasMedia){await state?.markSeen?.(message.messageId);await reply('当前自主 Agent 的输入合同为文字。渠道附件收发代码已保留，附件进入思考需要另行启用。');return;}
    if(text.length>1024){await reply('当前每条输入上限为 1024 字符，请分段发送；内容不会被截断。');await state?.markSeen?.(message.messageId);return;}
    if(text.startsWith('/')&&!/^\/(?:pause|resume|status|stop|steer|help|remind|reminders|cancel-reminder|goals|goal)(?:\s|$)/.test(text)){await reply('本 Agent 只有一个会话；会话、模型、角色与工作区请在 Web 统一管理。');await state?.markSeen?.(message.messageId);return;}
    if(text==='/help'){await reply('/pause 暂停运行；/resume 恢复运行许可（不改变手机回复开关）；/status 查看唯一会话；/steer 内容 显式插话。\n可直接说“10分钟后提醒我休息”或“每天晚上10点提醒我收工”。/reminders 查看；/cancel-reminder 编号 取消。时间按 Human 配置时区，不明确时先澄清。\n/goals 查看目标；/goal 编号 查看详情；/goal confirm|pause|cancel|retry 编号 确认、暂停、取消或明确重试。');await state?.markSeen?.(message.messageId);return;}
    const steer=/^\/steer\s+(.+)$/s.exec(text);
    const result=await this.remote.receive(key,{messageId:'msg-'+hash(channel+':'+botId+':'+message.messageId).slice(0,40),senderId:String(message.senderId),chatId:String(message.conversationId),privateChat:true,text:text==='/stop'?'/pause':steer?steer[1]:text,target:steer?'next-step':'next-turn'});
    if(result.command)await reply(result.command==='status'?'唯一会话 '+result.sessionId+'；状态 '+result.desired:result.command==='paused'?'已暂停运行，手机回复开关保持原设置。':'已恢复运行许可，手机回复开关保持原设置。');else if(result.refused)await reply('该命令不能创建或切换本 Agent 的唯一会话。');
    await state?.markSeen?.(message.messageId);
  }
  async askDirect(sessionId,prompt,{channel,singleRequestId,signal}={}){
    if(channel!=='office')throw new Error('SINGLE_SESSION_CHAT_INGRESS_REQUIRED');
    const run=async()=>{if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1024)throw new Error('OFFICE_INPUT_TOO_LARGE');const s=await this.runtime.state();if(sessionId!==s.sessionId)throw new Error('STALE_SESSION');const requestId='office-'+hash(String(singleRequestId??prompt)).slice(0,40);let after=0;const deadline=Date.now()+300000,pauseRevision=s.pauseRevision??0;
      await this.runtime.control({op:'message',sessionId,requestId,text:prompt,origin:'office',target:'next-turn'});
      while(!signal?.aborted&&!this.closed&&Date.now()<deadline){const current=await this.runtime.state();if(current.sessionId!==sessionId)throw new Error('STALE_SESSION');if((current.pauseRevision??0)!==pauseRevision||current.stopReason==='shutdown')throw new Error('OFFICE_CANCELLED');const feed=await this.runtime.events(after);const answer=feed.events.find(e=>['assistant','wait'].includes(e.kind)&&e.replyToRequests?.includes(requestId));if(answer)return answer.text;after=feed.events.at(-1)?.seq??after;if(feed.events.length===100)continue;if(['error','budget'].includes(current.stopReason)||!current.canThink)throw new Error('OFFICE_MODEL_FAILED');if(!current.agentBusy&&current.inbox>0&&current.desired==='paused'){if(this.remote.wakeBlock().blocked)throw new Error('RUN_REQUIRES_RESUME');await this.remote.controlRuntime({op:'once',sessionId,expectedEpoch:current.cancelEpoch},{automatic:true});}await sleep(500);}throw new Error('OFFICE_CANCELLED');};
    this.directTail=this.directTail.catch(()=>{}).then(run);return this.directTail;
  }
  async describe(){const bots=this.service?await this.service.listBots():[];const paired=await Promise.all(this.remote.db.prepare("SELECT id,enabled FROM channel WHERE kind='im-unified'").all().map(async row=>{const bot=bots.find(b=>channelKey(canonical(b.channel),b.botId)===row.id),received=this.remote.db.prepare("SELECT count(*) AS n FROM inbound WHERE channel=? AND status='committed' AND kind='message'").get(row.id).n,sent=this.remote.db.prepare("SELECT count(*) AS n FROM delivery WHERE channel=? AND state='sent'").get(row.id).n;let weixin;if(bot&&canonical(bot.channel)==='weixin')try{weixin=await this.service.describeBot(bot.botId);}catch{/* Missing/offline metadata must not hide an existing binding. */}return {...row,platform:canonical(bot?.channel??''),received,sent,transportDuplex:received>0&&sent>0,...(weixin?{connectionState:weixin.connectionState??(weixin.connected?'connected':'unknown'),connectionHealth:weixin.connectionHealth??null,weixinDelivery:weixin.weixinDelivery??null}:{})};}));return {sessionMode:'single',channels:IM_CHANNELS.map(c=>({...c,available:!c.platform||c.platform===process.platform,activation:this.activationStates.get(c.id)??{ready:false,pending:true},bots:bots.filter(b=>canonical(b.channel)===c.id).length,pairError:this.remote.preference('pair-error:'+c.id)||null})),paired,phoneVerified:paired.some(p=>p.transportDuplex),proofMeaning:'真实入站已入箱且供应商接受了出站，不代表人类已读'};}
  async close(){this.closed=true;await this.ingressTail.catch(()=>{});}
}
