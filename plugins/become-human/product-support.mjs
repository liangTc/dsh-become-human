const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const fail=code=>{throw new Error(code);};

export function validatePrices(rows){
  if(!Array.isArray(rows)||rows.length>50)fail('INVALID_USAGE_PRICES');
  const keys=new Set();return rows.map(row=>{
    if(!row||typeof row.provider!=='string'||typeof row.model!=='string'||row.provider.length>120||row.model.length>160||!/^[A-Z]{3}$/.test(row.currency??'CNY'))fail('INVALID_USAGE_PRICES');
    const key=row.provider+'/'+row.model;if(keys.has(key))fail('DUPLICATE_USAGE_PRICE');keys.add(key);
    const price={provider:row.provider,model:row.model,currency:row.currency??'CNY'};
    for(const key of ['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion','perRequest']){const n=row[key]??0;if(!Number.isFinite(n)||n<0||n>1000000)fail('INVALID_USAGE_PRICES');price[key]=n;}return price;
  });
}

export function usageSummary(journal,id,input={}){
  journal.assertAdmitted(id);const now=Date.now(),since=input.since??Math.floor(now/86400000)*86400000,until=input.until??now;
  if(!Number.isSafeInteger(since)||!Number.isSafeInteger(until)||since<0||until<since||until-since>93*86400000)fail('INVALID_USAGE_QUERY');
  const prices=journal.value(id,'usagePrices',[]),groups=new Map();
  for(const row of journal.db.prepare('SELECT a.request,a.config,a.usage,a.usage_confidence,a.state,r.amount FROM attempt a LEFT JOIN reservation r ON r.id=a.id WHERE a.agent=? AND a.started>=? AND a.started<=? ORDER BY a.started').all(id,since,until)){
    const config=parse(row.config)??{},request=parse(row.request)??{},usage=parse(row.usage),lane=request.lane==='foreground'?'owner':'autonomous';
    const key=JSON.stringify([config.provider??'unknown',config.model??'unknown',lane]);let item=groups.get(key);
    if(!item){item={provider:config.provider??'unknown',model:config.model??'unknown',lane,requests:0,reportedTokens:0,unknownUsageRequests:0,conservativeAdmission:0,failedRequests:0,estimatedCost:null,currency:null};groups.set(key,item);}
    item.requests++;item.conservativeAdmission+=row.amount??0;if(['failed','validation-rejected','output-limit','interrupted'].includes(row.state))item.failedRequests++;
    if(row.usage_confidence==='reported'&&usage){
      item.reportedTokens+=usage.totalTokens??0;const price=prices.find(p=>p.provider===item.provider&&p.model===item.model);
      if(price){const output=usage.outputTokens??0,cacheRead=usage.cacheReadTokens??0,cacheWrite=usage.cacheWriteTokens??0,input=usage.totalTokens===undefined?usage.inputTokens??0:Math.max(0,usage.totalTokens-output-cacheRead-cacheWrite);item.estimatedCost=(item.estimatedCost??0)+(input*price.inputPerMillion+output*price.outputPerMillion+cacheRead*price.cacheReadPerMillion+cacheWrite*price.cacheWritePerMillion)/1000000+price.perRequest;item.currency=price.currency;}
    }else item.unknownUsageRequests++;
  }
  const items=[...groups.values()];return {since,until,timeBasis:'UTC day by default',items,prices,requests:items.reduce((n,x)=>n+x.requests,0),reportedTokens:items.reduce((n,x)=>n+x.reportedTokens,0),unknownUsageRequests:items.reduce((n,x)=>n+x.unknownUsageRequests,0),conservativeAdmission:items.reduce((n,x)=>n+x.conservativeAdmission,0),costScope:'User-supplied prices and provider-reported usage only; not an invoice. Unknown usage, subscription and external tool fees are not inferred.'};
}

export function readiness(factory,id){
  const settings=factory.autonomy.settings(id),profile=factory.management.profile(id),execution=factory.management.execution(id);
  const routed=execution.routes?.foreground??factory.config;
  return {items:[
    {id:'model',label:'模型路线',status:routed.provider&&routed.model?'done':'todo',section:'model',detail:'检查已配置路线；未额外调用模型验证凭据。'},
    {id:'persona',label:'人格、职责和兴趣',status:profile.role&&profile.interests&&profile.corePrompt?.length>=20?'done':'todo',section:'persona',detail:'补充你希望她关心什么、如何交流和哪些行为需要先询问。'},
    {id:'autonomy',label:'自主事件循环',status:settings.enabled?'done':'optional',section:'autonomy',detail:settings.enabled?'按配置检查时机和任务。':'当前可仅聊天；启用后才自主推进。'},
    {id:'research',label:'外部学习',status:settings.learningEnabled&&(settings.searchEnabled||settings.sources?.length)?'done':'optional',section:'autonomy',detail:'公开搜索或指定来源至少启用一种；关闭不会影响普通聊天。'},
    {id:'quiet',label:'时区和免打扰',status:'review',section:'autonomy',detail:`UTC偏移 ${settings.timeZoneOffsetMinutes} 分钟；免打扰 ${settings.quietStart}:00–${settings.quietEnd}:00，请核对使用地区。`},
    {id:'quota',label:'自主开销限制',status:settings.quotaEnabled?'done':'review',section:'autonomy',detail:settings.quotaEnabled?'主人聊天与自主额度分别记账。':'当前自主不限额，适合开发短测；正式使用可设置预算。'}
  ],tools:factory.tools?.catalog(id)??[],singleSession:true};
}
