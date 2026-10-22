import {createHash} from 'node:crypto';
const error=code=>Object.assign(new Error(code),{code});
const identityKeys=['botId','accountId','accountJid','authDirectory','ownerUserId','appId','clientId','platformId','userId','corpId','agentId','homeserver','baseUrl','domain','deviceId','imapHost','smtpHost','transport'];
function publicWeixinHealth(bot){
  const source=bot?.weixinDelivery;if(!source||typeof source!=='object')return {};
  const d={scope:source.scope==='bound-owner'?'bound-owner':'unknown',windowIsEstimate:true,estimatedWindowMs:86400000};
  for(const key of ['lastInboundAt','contextUpdatedAt','estimatedWindowExpiresAt','lastSendAttemptAt','lastSendSuccessAt','lastSendFailureAt'])d[key]=d.scope==='bound-owner'&&Number.isSafeInteger(source[key])&&source[key]>0?source[key]:null;
  d.windowEstimate=d.scope==='bound-owner'&&['within','outside','unknown'].includes(source.windowEstimate)?source.windowEstimate:'unknown';
  d.sendability=d.scope==='bound-owner'&&['unknown','available','refresh-needed','failed'].includes(source.sendability)?source.sendability:'unknown';
  d.lastSendFailureCode=d.scope==='bound-owner'&&['send-rejected','network-error','timeout','http-error','bot-not-connected','invalid-target','weixin-send-failed','aborted'].includes(source.lastSendFailureCode)?source.lastSendFailureCode:null;
  d.lastSendFailureProviderCode=d.scope==='bound-owner'&&/^-?\d{1,8}$/.test(String(source.lastSendFailureProviderCode??''))?String(source.lastSendFailureProviderCode):null;
  return {connectionState:['connected','connecting','offline','error'].includes(bot.state)?bot.state:'unknown',connectionHealth:{status:['healthy','degraded','error','offline'].includes(bot.health?.status)?bot.health.status:'unknown',summary:bot.health?.status==='degraded'?'微信消息同步在线；主动发送状态需要核对。':'连接状态不保证平台当前允许发送。',lastCheckedAt:Number.isSafeInteger(bot.health?.lastCheckedAt)?bot.health.lastCheckedAt:null},weixinDelivery:d};
}
export async function nativeAccountProof({channel,botId,configStore,credentials,coreController}){
  const config=configStore?.get?.(botId);if(!config)throw error('account-unverified');
  const identity=Object.fromEntries(identityKeys.filter(k=>config[k]!==undefined).map(k=>[k,config[k]]));
  if(!Object.keys(identity).some(k=>k!=='botId'))throw error('account-unverified');
  const refs=Object.entries(config).filter(([k,v])=>k.endsWith('Ref')&&typeof v==='string'&&v.trim()).sort(([a],[b])=>a.localeCompare(b));
  if(!refs.length&&!['whatsapp','imessage'].includes(channel))throw error('account-unverified');
  const credentialVersions=[];
  for(const [key,ref] of refs){const resolved=await credentials?.resolve(ref);if(!resolved?.value)throw error('account-unverified');credentialVersions.push([key,ref,createHash('sha256').update(resolved.value).digest('hex')]);}
  const status=await coreController.status();const bot=(status.bots??status.accounts??[]).find(b=>b.botId===botId);
  if(!bot||bot.connected===false||['error','disconnected','missing-token','closed'].includes(bot.state))throw error('bot-not-connected');
  const fingerprint=createHash('sha256').update(JSON.stringify({channel,identity,credentialVersions})).digest('hex');
  return {version:1,botId,channel,connected:true,account:{fingerprint,proof:'native-bound-config-and-credential'},capabilities:['proactive-text-checked'],...(channel==='weixin'?publicWeixinHealth(bot):{})};
}
