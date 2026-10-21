import {createHash} from 'node:crypto';
const error=code=>Object.assign(new Error(code),{code});
const identityKeys=['botId','accountId','accountJid','authDirectory','ownerUserId','appId','clientId','platformId','userId','corpId','agentId','homeserver','baseUrl','domain','deviceId','imapHost','smtpHost','transport'];
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
  return {version:1,botId,channel,connected:true,account:{fingerprint,proof:'native-bound-config-and-credential'},capabilities:['proactive-text-checked']};
}
