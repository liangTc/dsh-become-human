const hidden=new Set(['apikey','token','password','authorization','headers','secret','credential','credentials','systemprompt','prompt','reasoning','reasoningtext','reasoningcontent','chainofthought','thoughtprocess','internalreasoning','rawresponse','rawcompletion']);
export function readableRecord(value,depth=0){
 if(depth>20)return '[嵌套内容过深]';
 if(typeof value==='string')return value.replace(/([?&](?:token|api_key|access_token)=)[^\s&]+/gi,'$1[已隐藏]').replace(/sk-[\w-]{16,}/g,'[已隐藏]');
 if(Array.isArray(value))return value.map(v=>readableRecord(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!hidden.has(key.toLowerCase().replace(/[_-]/g,''))).map(([key,v])=>[key,readableRecord(v,depth+1)]));
 return value;
}
export const recordLabels={id:'编号',taskId:'任务编号',roundId:'轮次编号',requestId:'请求编号',attemptId:'调用编号',eventId:'事件编号',messageId:'消息编号',memoryId:'记忆编号',noteId:'笔记编号',goalId:'目标编号',summary:'摘要',text:'内容',content:'内容',question:'本次问题',answer:'回答',result:'结果',reason:'原因',error:'错误',code:'错误码',title:'标题',name:'名称',description:'说明',status:'状态',state:'状态',kind:'类型',type:'类别',created:'创建时间',updated:'更新时间',started:'开始时间',ended:'结束时间',completed:'完成时间',time:'时间',changed:'修改时间',expires:'到期时间',version:'版本',origin:'来源',lane:'执行阶段',data:'记录内容',usage:'用量',inputTokens:'输入 token',outputTokens:'输出 token',cacheReadTokens:'缓存读取 token',cacheWriteTokens:'缓存写入 token',totalTokens:'总 token',usage_confidence:'计量依据',plan:'执行计划',candidate:'候选方向',checkpoint:'保存的进度',behaviorResult:'行为结果',refs:'依据编号',quotes:'原文摘录',evidence:'依据',sources:'来源',source:'来源',url:'来源链接',before:'修改前',after:'修改后',feedback:'反馈',annotations:'人工批注',notes:'笔记',nextAction:'下一步',why:'选择原因',value:'内容',items:'条目',changes:'变更',intent:'意图',method:'方法',outcome:'结果',expectedValue:'预期价值',failed:'失败',success:'成功',confidence:'可信程度',request:'请求',actionId:'产物编号',memoryRefs:'原记忆依据',batchId:'批次编号',summaryId:'摘要编号',memoryIds:'原记忆编号'};
export function recordValue(value,key=''){
 if(value===null||value===undefined)return '未记录';
 if(typeof value==='boolean')return value?'是':'否';
 if(typeof value==='number'&&/^(created|updated|started|ended|completed|time|changed|expires|restoredAt)$/.test(key)&&value>1e11)return new Date(value).toLocaleString('zh-CN',{hour12:false});
 return String(value);
}

// Normal screens are an editorial projection, never an inspector of arbitrary
// storage fields. Unknown leaf fields and internal references belong in exports.
const labels={domain:'相关记忆与目标',payload:'内容',input:'输入',output:'输出',blocks:'较早对话',chunks:'较早对话',summaries:'记忆摘要',ownerEvidence:'你的相关原话',observedBoard:'当前事项',current:'现状',conversationSummary:'对话摘要',conversation:'对话',recent:'近期记录',personality:'性格',currentInput:'本次输入',history:'对话历史',draft:'准备回复的内容',unpublishedDraft:'尚未发出的内容',issues:'需要调整的问题',replyUnits:'分条回复',currentNote:'相关笔记',currentExecution:'正在执行',recalledContext:'回忆内容',core:'人物设定',corePrompt:'人物设定',role:'发言人',owner:'主人',agent:'数字人',relationship:'关系',interests:'兴趣',preferences:'偏好',responsibilities:'职责',background:'背景',summary:'摘要',text:'内容',content:'内容',question:'本次问题',answer:'回答',reason:'原因',title:'标题',name:'名称',description:'说明',result:'结果',outcome:'结果',before:'修改前',after:'修改后',feedback:'反馈',annotation:'批注',annotations:'人工批注',nextAction:'下一步',why:'选择原因',intent:'意图',expectedValue:'预期价值',value:'内容',quote:'原话',quotes:'原文摘录',body:'内容',message:'说明',conclusion:'结论',findings:'发现',notes:'笔记',facts:'事实',memories:'记忆',instructions:'任务要求',instruction:'任务要求',prompt:'任务要求',system:'角色与规则',context:'相关背景',persona:'人物设定',goal:'目标',goals:'目标',topic:'话题',topics:'话题',benefit:'帮助',motivation:'动机',decision:'本次选择',action:'行动',plan:'计划',changes:'变化',suggestion:'建议',suggestions:'建议',items:'内容',data:'内容',response:'回复',requested:'需要完成',learned:'收获',nextStep:'下一步',nextSteps:'下一步',questionToOwner:'想问你的问题',ownerBenefit:'对你的帮助',selfBenefit:'对自身的帮助',purpose:'用途',error:'未完成原因',status:'状态',state:'状态'};
const internal=/^(?:.*(?:Ids?|Refs?|Digest|Hash)|refs|references|evidence|sources|source|citations|checkpoint|attempts|config|usage|metadata|version|epoch|turn|seq|trace|counts|omitted|reasoning.*|raw.*|.*Tokens)$/i;
const states={completed:'已完成',failed:'未完成',cancelled:'已取消',running:'进行中',pending:'等待中',active:'有效',included:'已采用',wait:'等待',WAIT:'等待',MESSAGE:'发送消息',success:'已完成',suspended:'已保存进度',selected:'已选择',executed:'已执行',generated:'已生成'};
export function userRecord(value,depth=0){
 if(depth>12||value===null||value===undefined)return null;
 if(typeof value==='string'){
   const text=readableRecord(value).trim();
   if(!text||/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text)||/^(?:[A-Z][A-Z0-9]*_){1,}[A-Z0-9_]+$/.test(text))return null;
   return states[text]??text;
 }
 if(typeof value!=='object')return value;
 if(Array.isArray(value)){const list=value.map(v=>userRecord(v,depth+1)).filter(v=>v!==null);return list.length?list:null;}
 const result={};
 for(const [key,v]of Object.entries(value)){
   if(internal.test(key))continue;
   const label=labels[key]??(/^[\u4e00-\u9fff]{1,20}$/u.test(key)?key:null);
   if(!label)continue;
   if(['status','state'].includes(key)&&!states[v])continue;
   if(['reason','error','decision'].includes(key)&&typeof v==='string'&&/^[a-z]+(?:[-_][a-z]+)+$/.test(v)&&!states[v])continue;
   const item=userRecord(v,depth+1);if(item!==null)result[label]=item;
 }
 return Object.keys(result).length?result:null;
}
export function modelText(value){
 if(typeof value!=='string')return userRecord(value);
 try{return userRecord(JSON.parse(value));}catch{return userRecord(value);}
}

const capabilityNames={'read-public-page':'阅读公开网页','compare-public-page':'比较网页变化','mcp-read-public-page':'通过 MCP 阅读网页','dsh-session-list':'查看 DSH 会话列表','dsh-session-read':'阅读 DSH 会话','dsh-session-prompt':'向 DSH 会话提交任务','dsh-session-cancel':'停止 DSH 会话任务','list-learning-notes':'查找已保存的笔记','read-learning-note':'阅读学习笔记','write-learning-report':'保存学习报告'};
export const capabilityName=value=>capabilityNames[value]??value??'扩展能力';
