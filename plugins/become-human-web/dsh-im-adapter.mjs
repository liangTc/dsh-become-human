// Uses the documented public dshIm service. Never uses the unauthenticated delivery HTTP endpoint.
export class DshImAdapter {
  constructor(service){this.service=service;}
  async verify(config){
    const targets=await this.service.listTargets(config.botId);const target=targets.find(t=>t.targetId===config.targetId);
    if(!target||!(target.kind==='user'||target.kind==='chat'&&/^\d+$/.test(target.route?.chatId??'')))throw new Error('PRIVATE_OWNER_REQUIRED');
    const account=await this.service.describeBot?.(config.botId);if(!account?.account?.fingerprint||typeof this.service.sendChecked!=='function')throw new Error('DSH_IM_CHECKED_DELIVERY_UNAVAILABLE');
    const {createHash}=await import('node:crypto');const targetDigest=createHash('sha256').update(JSON.stringify({kind:target.kind,route:Object.fromEntries(Object.entries(target.route).sort(([a],[b])=>a<b?-1:a>b?1:0))})).digest('hex');
    config.fingerprint=account.account.fingerprint;config.targetDigest=targetDigest;return {privateOwner:true};
  }
  async send(config,text){return this.service.sendChecked(config.botId,config.targetId,text,{expectedFingerprint:config.fingerprint,expectedTargetDigest:config.targetDigest,signal:AbortSignal.timeout(8000)});}
}
