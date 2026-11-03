const fail=code=>{throw Error(code);};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function extensionEditors(manifest,nodes){
  const editors=manifest.dsh?.human?.configEditors;if(editors===undefined)return [];
  if(!Array.isArray(editors)||editors.length>64)fail('EXTENSION_EDITOR_INVALID');
  const ids=new Set(nodes.map(n=>n.id)),seen=new Set();
  for(const e of editors){if(!plain(e)||!ids.has(e.nodeId)||seen.has(e.nodeId))fail('EXTENSION_EDITOR_INVALID');seen.add(e.nodeId);}
  return editors.filter(e=>e.kind==='public-sources'&&e.version===1).map(({nodeId,kind,version})=>({nodeId,kind,version}));
}
export function validatePublicSourceConfig(config,validateUrl=value=>new URL(value)){
  if(!plain(config)||config.reviewWithModel!==undefined&&typeof config.reviewWithModel!=='boolean'||!Array.isArray(config.sources??[])||(config.sources??[]).length>8)fail('EXTENSION_SOURCE_CONFIG_INVALID');
  const seen=new Set();
  for(const row of config.sources??[]){
    if(!plain(row)||Object.keys(row).some(k=>!['id','title','url','intervalMs','emitInitial','format','enabled'].includes(k))||typeof row.id!=='string'||!/^[a-z][a-z0-9._:-]{0,119}$/.test(row.id)||seen.has(row.id)||typeof row.title!=='string'||!row.title.trim()||row.title.length>120||typeof row.url!=='string'||row.url.length>1200||!Number.isSafeInteger(row.intervalMs??600000)||(row.intervalMs??600000)<60000||(row.intervalMs??600000)>86400000||!['auto','feed','document'].includes(row.format??'auto')||row.emitInitial!==undefined&&typeof row.emitInitial!=='boolean'||row.enabled!==undefined&&typeof row.enabled!=='boolean')fail('EXTENSION_SOURCE_CONFIG_INVALID');
    seen.add(row.id);try{validateUrl(row.url);}catch{fail('SOURCE_URL_NOT_ALLOWED');}
  }
}
export function validateEditorEntries(descriptor,entries,validateUrl){
  if(!Array.isArray(entries)||entries.some(n=>!plain(n)||typeof n.id!=='string'))fail('EXTENSION_CONFIGURATION_INVALID');
  const active=new Set();
  for(const editor of descriptor.configEditors??[]){
    const entry=entries.find(n=>n.id===editor.nodeId);if(!entry)fail('EXTENSION_CONFIGURATION_INVALID');
    validatePublicSourceConfig(entry.config??{},validateUrl);
    if(!entry.disabled)for(const source of entry.config?.sources??[])if(source.enabled!==false){if(active.has(source.id))fail('EXTENSION_SOURCE_ID_CONFLICT');active.add(source.id);}
  }
  return active;
}
export function sourceStatusView(status,{enabled=true}={}){
  if(!enabled)return {state:'disabled',title:'已停用',hint:'不再读取此来源；保留已有观察记录。'};
  if(!status)return {state:'unavailable',title:'等待后台注册',hint:'请检查后台是否已启动，以及扩展是否成功应用。'};
  if(status.checking)return {state:'checking',title:'正在读取',hint:'读取公开内容，不调用模型。'};
  if(status.lastError){
    const code=status.lastError,kind=/DNS|TIMEOUT|FETCH|NETWORK|ABORT/.test(code)?'network':/XML|JSON|FEED|FORMAT|PARSE|DOCUMENT/.test(code)?'format':/FULL|LIMIT|LARGE|TRUNCATED/.test(code)?'capacity':/URL|PRIVATE|REDIRECT|DENIED/.test(code)?'policy':/HTTP/.test(code)?'response':'unknown';
    const hints={network:'连接或域名解析失败，后台会延后重试。',format:'内容格式无法解析，请核对地址与格式。',capacity:'内容或积压超过处理范围，请查看详情后调整来源。',policy:'地址未通过公开来源检查，请使用公开网页或订阅地址。',response:'来源服务器未返回可用内容，后台会延后重试。',unknown:'本次读取未完成，可展开查看错误信息。'};
    return {state:'error',title:'读取失败',hint:hints[kind],kind};
  }
  if(!status.lastSuccess)return {state:'waiting',title:'等待首次读取',hint:'首次默认建立比对基线，之后仅提供变化的内容。'};
  return {state:'ready',title:status.pendingItems?'已读取，等待接收':'读取正常',hint:'已取得内容；不代表事实已核实或 Human 已决定行动。'};
}
