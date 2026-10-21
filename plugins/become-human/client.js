const el=id=>document.getElementById(id);
let controlCount=0,sendBusy=false,lastSeq=-1,receipt=0,receiptTarget=0;
let refreshTask,receiptTask,lastState,pendingMessage,pendingReminder,controlError='';
let requestSeq=0,lastAppliedRequest=0,lastBoot,lastRevision=-1;
const retiredBoots=new Set();
let autonomyDraftRevision=0,autonomyDraftDirty=false;

async function api(op){
  const requestId=++requestSeq;
  try{
    const r=await fetch(op?'/api/become-human/control':'/api/become-human/state',op?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(op)}:{cache:'no-store'});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error??'连接失败 '+r.status);
    return {data,requestId};
  }catch(e){e.requestSeq=requestId;throw e;}
}
function showError(e){if(e.requestSeq===undefined||e.requestSeq>=lastAppliedRequest){controlError=e.message;el('error').textContent=controlError;}}
function controls(){
  const s=lastState,busy=controlCount>0;
  for(const id of ['once','start'])el(id).disabled=!s||busy||s.agentBusy||s.canThink===false||s.desired==='running'||s.status==='running'||id==='start'&&s.interactiveOnly;
  el('pause').disabled=!s||(s.desired!=='running'&&s.status!=='running'&&!s.remote?.replyEnabled);
  el('save').disabled=!s||busy||s.agentBusy||s.desired!=='paused'||s.status==='running';
  const retry=el('retry');if(retry)retry.disabled=!s||busy||s.agentBusy||s.desired!=='paused'||!s.retryableInput;
  el('send').disabled=!s||sendBusy;
  if(el('reminder-create'))el('reminder-create').disabled=!s||busy||s.agentBusy||s.retiring;
  if(el('delete-preview'))el('delete-preview').disabled=!s||busy;
  if(el('delete-confirm'))el('delete-confirm').disabled=!s||busy||s.agentBusy||s.desired!=='paused'||!s.deletion?.preview||el('delete-confirmation').value!=='删除临时会话';
  if(el('delete-recover'))el('delete-recover').disabled=!s||busy||s.agentBusy||s.desired!=='paused'||!s.deletion?.retirements?.some(r=>r.phase!=='DONE');
  for(const id of ['memory-save','persona-auto','persona-rollback','session-preview'])if(el(id))el(id).disabled=!s||busy||s.agentBusy||s.retiring||s.desired!=='paused';
  if(el('session-confirm'))el('session-confirm').disabled=!s||busy||s.agentBusy||s.retiring||!s.retirement?.preview||el('session-confirmation').value!=='删除当前会话';
  for(const id of ['autonomy-save','learning-source-add'])if(el(id))el(id).disabled=!s||busy||s.agentBusy||s.desired!=='paused';
  for(const id of ['autonomy-pause','autonomy-resume','autonomy-grant'])if(el(id))el(id).disabled=!s||busy||!s.autonomy?.settings.enabled||s.retiring;
  if(el('autonomy-grant')&&s?.autonomy?.budget.quotaEnabled===false)el('autonomy-grant').disabled=true;
  if(el('autonomy-task-retry'))el('autonomy-task-retry').disabled=!s||busy||s.agentBusy||s.desired!=='paused'||!s.autonomy?.tasks.some(t=>t.status==='failed')||s.retiring;
}
function receiptLabel(){el('receipt').textContent='服务端累计渲染回执 '+receipt+'（页面呈现确认，不代表人类已读）';}
function applyState(response){
  const {data:s,requestId}=response;
  if(requestId<lastAppliedRequest)return false;
  const boot=typeof s.bootId==='string'?s.bootId:undefined;
  const revision=Number.isSafeInteger(s.revision)?s.revision:undefined;
  if(boot!==undefined&&boot!==lastBoot){
    if(retiredBoots.has(boot))return false;
    if(lastBoot!==undefined)retiredBoots.add(lastBoot);
    lastBoot=boot;lastRevision=-1;
  }
  if(revision!==undefined&&revision<lastRevision)return false;
  if(lastState&&s.sessionId!==lastState.sessionId){lastSeq=-1;receipt=0;receiptTarget=0;pendingMessage=undefined;pendingReminder=undefined;el('input').value='';}
  lastAppliedRequest=requestId;
  if(revision!==undefined)lastRevision=Math.max(lastRevision,revision);
  lastState=s;render(s);return true;
}
function queueReceipt(seq){
  receiptTarget=Math.max(receiptTarget,seq);
  if(receiptTask||receiptTarget<=receipt)return;
  receiptTask=(async()=>{
    while(receiptTarget>receipt){
      const target=receiptTarget,sessionId=lastState?.sessionId;
      const response=await api({op:'receipt',seq:target,sessionId});
      if(sessionId!==lastState?.sessionId)break;
      // Acknowledging rendered rows is not a human read receipt.
      if(!Number.isSafeInteger(response.data.receipt)||response.data.receipt<target)throw new Error('无效的渲染回执');
      if(response.data.bootId!==undefined&&retiredBoots.has(response.data.bootId))break;
      receipt=Math.max(receipt,response.data.receipt);receiptLabel();
      applyState(response);
    }
  })().catch(showError).finally(()=>{receiptTask=undefined;});
}
function render(s){
  const labels={running:'持续驱动已启动',paused:'已暂停'};
  el('state').textContent=(labels[s.desired]??s.desired)+(s.status==='running'?' · 正在思考':'');el('route').textContent=s.provider+' / '+s.model;
  el('successes').textContent=s.successes;const eventMode=s.autonomy?.settings.enabled,unlimited=eventMode&&s.autonomy.budget.quotaEnabled===false;el('used').textContent=eventMode?s.autonomy.budget.reservedTokens+' / '+(unlimited?'不设上限':s.autonomy.budget.tokenLimit):s.used+' / '+(s.localQuotaEnabled===false?'不设本地上限':s.budget);el('remaining').textContent=eventMode?(unlimited?'不设次数上限':Math.max(0,s.autonomy.budget.requestLimit-s.autonomy.budget.requests)):s.remaining===null?'不设次数上限':s.remaining;
  if(el('remaining-label'))el('remaining-label').textContent=eventMode?'本 UTC 日剩余自主请求':'本轮剩余调用';
  const usageLabel=s.lastUsageConfidence==='unknown'?' · 最近用量未知，保留预留':s.lastUsageConfidence==='legacy-unverified'?' · 旧调用用量尚未对账':s.lastUsage?' · 最近输入 '+(s.lastUsage.inputTokens+(s.lastUsage.cacheReadTokens??0)+(s.lastUsage.cacheWriteTokens??0))+' / 输出 '+s.lastUsage.outputTokens:'';
  el('details').textContent='版本 '+s.version+' · 间隔 '+s.intervalMs/1000+' 秒 · 收件箱 '+s.inbox+' · 停止原因 '+(s.stopReason??'—')+usageLabel+(s.canThink===false?' · 本轮验证额度不足，启动已禁用':'');
  if(el('long-run')){const r=s.longRun,next=s.desired==='running'&&s.nextTickAt?' · 下次检查 '+new Date(s.nextTickAt).toLocaleTimeString():'';el('long-run').textContent=eventMode?'事件与任务模式 · '+(unlimited?'自主额度限制已关闭':'自主任务按当前 UTC 日额度准入')+' · 主人聊天单独记账'+next:r?'长测 '+Math.floor(r.elapsedMs/60000)+' 分钟 · 自主尝试 '+r.autonomousAttempts+' · 输入尝试 '+r.inputAttempts+' · 表达 '+r.expressions+' · WAIT '+r.waits+' · 异常 '+r.failures+' · 报告 token '+r.reportedTokens+next:'尚未启动不设次数上限的持续驱动。';}
  controls();
  if(document.activeElement!==el('persona'))el('persona').value=s.persona;el('memory').textContent=s.memory;
  el('audit').textContent=JSON.stringify({sessionId:s.sessionId,runtime:s.runtime,reasoningEffort:s.reasoningEffort,lastUsage:s.lastUsage,lastUsageConfidence:s.lastUsageConfidence,lastError:s.lastError,attempts:s.attempts,events:s.audit},null,2);
  if(el('deletion')){
    const box=el('deletion'),preview=s.deletion?.preview;box.replaceChildren();
    if(preview){
      const summary=document.createElement('p');summary.textContent='将清理 '+preview.files.length+' 个受管文件及对应的简记、消息和调用记录。';box.append(summary);
      const labels={'backup':'备份','cache':'缓存','export':'导出','native-session-directory':'对话历史','owned-copies-directory':'受管副本'};
      for(const file of preview.files){const item=document.createElement('div');item.textContent=(labels[file.kind]??'受管文件')+' · '+file.name+' · '+file.bytes+' B';box.append(item);}
    }else box.textContent='先创建临时会话，查看清理范围。';
    const latest=s.deletion?.retirements?.[0];
    el('deletion-status').textContent=(latest?'最近清理：'+(latest.phase==='DONE'?'已完成':'尚未完成')+'。 ':'')+(s.deletion?.lastError?'清理恢复受阻，可重试。 ':'')+'此区仅报告临时会话；当前会话清理状态见上方。';
  }
  if(el('memories')){
    const box=el('memories');box.replaceChildren();const names={identity:'身份',working:'工作',episode:'经历',fact:'事实 / 陈述',goal:'目标',skill:'技能'};
    for(const m of s.memories??[]){const item=document.createElement('div');item.className='message';item.textContent=(names[m.type]??m.type)+' · '+(m.namespace==='fictional'?'虚构':'现实')+'\n'+JSON.stringify(m.payload)+'\n来源 '+m.refs.map(id=>id.slice(0,8)).join('、');box.append(item);}if(!s.memories?.length)box.textContent='尚无来源记忆。';
    const p=s.personaState;el('persona-state').textContent=p?'版本 '+p.version+' · 详略 '+p.tendencies.verbosity.toFixed(2)+' · 幽默 '+p.tendencies.humor.toFixed(2)+(p.temporary?' · 临时语气 '+p.temporary.tone:' · 无临时覆盖'):'角色状态暂不可用';
    for(const field of ['verbosity','humor'])if(document.activeElement!==el('auto-'+field))el('auto-'+field).checked=p?.autoEnabled?.includes(field)??false;
    const preview=s.retirement?.preview;el('session-scope').textContent=preview?'将清理 '+preview.files.length+' 个文件，以及 '+preview.includes.join('、')+'。保留 '+preview.retains.join('、')+'。':'清理前请先查看范围。';
    const operation=s.retirement?.operations?.at(-1);el('session-cleanup').textContent=operation?'清理阶段：'+operation.phase+(operation.error?' · '+operation.error:''):'未执行当前会话清理。';
  }
  const seq=s.messages.at(-1)?.seq??0;
  if(seq!==lastSeq){lastSeq=seq;el('messages').replaceChildren();for(const m of s.messages){const d=document.createElement('div');d.className='message '+m.kind;const label=document.createElement('small');label.textContent=(m.kind==='user'?'用户':m.kind==='wait'?'等待':m.kind==='status'?'运行状态':'Agent')+' · '+new Date(m.created).toLocaleTimeString();d.append(label,document.createTextNode(m.displayText??m.text));el('messages').append(d);}if(!s.messages.length)el('messages').textContent='尚无消息。先加入消息，再启动一次思考。';}
  receipt=Math.max(receipt,s.receipt??0);receiptLabel();
  const errorLabels={OUTPUT_LIMIT:'输出达到上限，已暂停。','MODEL_FINISH_max-tokens':'输出达到上限，已暂停。'};
  el('error').textContent=s.lastError&&s.stopReason==='error'?(errorLabels[s.lastError]??'调用失败：'+s.lastError):controlError;
  queueReceipt(seq);
  renderAutonomy(s);renderReminders(s);
}
function reminderLocal(time,offset){return new Date(time+offset*60000).toISOString().slice(0,19).replace('T',' ');}
function renderReminders(s){
  if(!el('reminders'))return;
  const offset=s.autonomy?.settings.timeZoneOffsetMinutes??480;
  el('reminder-zone').textContent='时间按 Human 配置时区 UTC'+(offset>=0?'+':'')+(offset/60)+'；至少提前30秒。';
  const box=el('reminders');box.replaceChildren();const labels={pending:'待触发',staged:'正在提交',committed:'已写入会话',cancelled:'已取消',expired:'已过期'};
  for(const r of s.reminders??[]){const item=document.createElement('div');item.className='message';item.textContent=reminderLocal(r.dueAt,offset)+' · '+(labels[r.status]??r.status)+'\n'+r.text+'\n编号：'+r.id;if(r.status==='pending'){const cancel=document.createElement('button');cancel.textContent='取消提醒';cancel.disabled=controlCount>0||s.agentBusy||s.retiring;cancel.onclick=()=>control({op:'reminder-cancel',reminderId:r.id,sessionId:s.sessionId});item.append(cancel);}box.append(item);}if(!s.reminders?.length)box.textContent='尚未登记提醒。';
}
function renderAutonomy(s){
  if(!el('autonomy-status'))return;const a=s.autonomy;if(!a){el('autonomy-status').textContent='当前运行版本尚未启用新版自主内核。';return;}
  for(const [id,key] of [['autonomy-enabled','enabled'],['learning-enabled','learningEnabled'],['search-enabled','searchEnabled'],['proactive-enabled','proactiveEnabled'],['autonomy-quota-enabled','quotaEnabled']])if(!autonomyDraftDirty&&document.activeElement!==el(id))el(id).checked=key==='quotaEnabled'?a.settings[key]!==false:!!a.settings[key];
  for(const [id,key] of [['autonomy-tokens','tokenLimit'],['autonomy-requests','requestLimit'],['search-provider','searchProvider'],['search-endpoint','searchEndpoint']])if(!autonomyDraftDirty&&document.activeElement!==el(id))el(id).value=a.settings[key]??(key==='searchProvider'?'bing':'');
  el('research-status').textContent=a.settings.searchEnabled?'自主发现已启用：按学习检查间隔选择问题，搜索不可用时等待，不编造结果。':'自主发现未启用；开启后可在参考网址以外搜索。';
  const phases={idle:'等待事件',dialogue:'正在与你交流',searching:'正在搜索外部内容','checking-source':'正在读取资料',selecting:'正在选择问题',executing:'正在执行学习任务',waiting:'等待合格任务','waiting-budget':'等待额外额度','autonomy-paused':'自主已暂停','autonomy-error':'自主任务受阻',preempting:'正在等后台任务收尾',preempted:'已让出任务执行权','learned-without-notification':'已学习，等待合适的交流时机'};
  el('autonomy-status').textContent=(phases[a.phase]??a.phase)+(a.paused?' · 自主已暂停':'')+' · 自主请求 '+a.budget.requests+' / '+(a.budget.quotaEnabled===false?'不设上限':a.budget.requestLimit)+' · 保守 token '+a.budget.reservedTokens+' / '+(a.budget.quotaEnabled===false?'不设上限':a.budget.tokenLimit)+(a.error?' · '+a.error:'');
  const sources=el('learning-sources');sources.replaceChildren();for(const source of a.settings.sources){const p=document.createElement('p');p.textContent=source.topic+' · '+source.url;const remove=document.createElement('button');remove.textContent='移除来源';remove.disabled=s.agentBusy||s.desired!=='paused';remove.onclick=()=>control({op:'autonomy-configure',settings:{sources:a.settings.sources.filter(x=>x.url!==source.url)}});p.append(remove);sources.append(p);}
  const request=a.pendingBudgetRequest;el('budget-request').textContent=a.budget.quotaEnabled===false?'自主额度限制已关闭，用量继续记录，无需补额。':request?'待授权：'+request.objective+' '+request.value+'；'+(request.estimateKind==='remaining-task-conservative'?'完成剩余任务保守预估 '+request.remainingTaskTokens+' token / '+request.remainingTaskRequests+' 次；当前可用 '+request.availableTokens+' token / '+request.availableRequests+' 次；':'')+'建议补充 '+request.suggestedTokens+' token / '+request.suggestedRequests+' 次请求。额外额度仅用于自主任务。':'额外额度只增加自主池，不改变资料或动作许可。';
  const grants=el('resource-grants');grants.replaceChildren();for(const grant of a.budget.grants){const p=document.createElement('p');p.textContent=(grant.mode==='daily'?'每日':'本窗口')+' +'+grant.tokens+' token / '+grant.requests+' 次，至 '+new Date(grant.expires).toLocaleString();const button=document.createElement('button');button.textContent='撤销';button.onclick=()=>control({op:'autonomy-grant-revoke',grantId:grant.id});p.append(button);grants.append(p);}
  const notes=el('learning-notes');notes.replaceChildren();for(const note of a.notes){const box=document.createElement('div');box.className='message';const title=document.createElement('strong');title.textContent=note.data.title;const summary=document.createElement('p');summary.textContent=note.data.summary;const relevance=document.createElement('p');relevance.textContent=note.data.relevance;const source=document.createElement('a');source.href=note.data.source.url;source.textContent='查看原始来源';source.target='_blank';source.rel='noopener noreferrer';box.append(title,summary,relevance,source);for(const [value,label] of [['useful','有用'],['not-now','暂时不用'],['correction','纠正']]){const button=document.createElement('button');button.textContent=label;button.disabled=s.agentBusy;button.onclick=()=>control({op:'learning-feedback',noteId:note.id,value,comment:value==='correction'?el('learning-correction').value:''});box.append(button);}const remove=document.createElement('button');remove.textContent='删除笔记';remove.disabled=s.agentBusy;remove.onclick=()=>control({op:'learning-note-delete',noteId:note.id});box.append(remove);if(note.feedback){const p=document.createElement('p');p.textContent='主人反馈：'+note.feedback.value+(note.feedback.comment?' · '+note.feedback.comment:'');box.append(p);}notes.append(box);}if(!a.notes.length)notes.textContent='尚无实际学习笔记。';
}
function refresh(){
  if(refreshTask)return refreshTask;
  refreshTask=api().then(applyState).catch(showError).finally(()=>{refreshTask=undefined;});
  return refreshTask;
}
async function control(op){
  if(controlCount>0&&op.op!=='pause')return;
  controlError='';controlCount++;controls();
  const draftRevision=autonomyDraftRevision;
  try{const response=await api(op);if(op.op==='autonomy-configure'&&Object.hasOwn(op.settings??{},'enabled')&&draftRevision===autonomyDraftRevision)autonomyDraftDirty=false;applyState(response);}catch(e){showError(e);}finally{controlCount--;controls();await refresh();}
}
async function send(){
  if(sendBusy)return;
  const text=el('input').value;
  if(!text.trim()){el('error').textContent='请先输入消息。';return;}
  // Reuse the same key after an ambiguous failure if the text is unchanged.
  if(!pendingMessage||pendingMessage.text!==text)pendingMessage={text,requestId:crypto.randomUUID(),sessionId:lastState?.sessionId};
  const submitted=pendingMessage;
  controlError='';sendBusy=true;controls();
  try{
    applyState(await api({op:'message',...submitted}));
    if(el('input').value===submitted.text)el('input').value='';
    if(pendingMessage===submitted)pendingMessage=undefined;
  }catch(e){showError(e);}finally{sendBusy=false;controls();}
}
el('once').onclick=()=>control({op:'once'});el('start').onclick=()=>control({op:'start'});el('pause').onclick=()=>control({op:'pause'});el('refresh').onclick=refresh;el('save').onclick=()=>control({op:'persona',text:el('persona').value});
el('send').onclick=send;
if(el('reminder-create'))el('reminder-create').onclick=async()=>{
  if(controlCount||!lastState)return;
  const time=el('reminder-time').value,text=el('reminder-text').value.trim(),offset=lastState.autonomy?.settings.timeZoneOffsetMinutes??480;
  if(!time||!text||!el('reminder-time').checkValidity()){el('error').textContent='请填写明确的日期、时间和提醒内容。';return;}
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if(!parts){el('error').textContent='日期格式无效。';return;}
  const [,y,m,d,h,min,sec='0']=parts,dueAt=Date.UTC(+y,+m-1,+d,+h,+min,+sec)-offset*60000;
  if(!pendingReminder||pendingReminder.dueAt!==dueAt||pendingReminder.text!==text)pendingReminder={dueAt,text,requestId:crypto.randomUUID(),sessionId:lastState.sessionId};
  const submitted=pendingReminder;controlError='';controlCount++;controls();
  try{applyState(await api({op:'reminder-create',...submitted}));if(el('reminder-text').value.trim()===text&&el('reminder-time').value===time){el('reminder-text').value='';el('reminder-time').value='';}if(pendingReminder===submitted)pendingReminder=undefined;}catch(e){showError(e);}finally{controlCount--;controls();await refresh();}
};
if(el('retry'))el('retry').onclick=()=>control({op:'retry'});
if(el('delete-preview')){
  el('delete-preview').onclick=()=>control({op:'delete-fixture-preview'});
  el('delete-confirmation').oninput=controls;
  el('delete-confirm').onclick=()=>{const preview=lastState?.deletion?.preview;if(preview)control({op:'delete-fixture-confirm',id:preview.id,token:preview.token,confirmation:el('delete-confirmation').value});};
  el('delete-recover').onclick=()=>control({op:'delete-fixture-recover'});
}
if(el('memory-save')){
  el('memory-save').onclick=()=>{const text=el('memory-input').value.trim();if(!text)return;control({op:'memory-save',type:el('memory-type').value,payload:{entity:'user',predicate:'note',value:text}});};
  el('persona-auto').onclick=()=>control({op:'persona-auto',fields:['verbosity','humor'].filter(f=>el('auto-'+f).checked)});
  el('persona-rollback').onclick=()=>control({op:'persona-rollback'});
  el('session-preview').onclick=()=>control({op:'session-delete-preview'});
  el('session-confirmation').oninput=controls;
  let deletionRequest;
  el('session-confirm').onclick=()=>{const preview=lastState?.retirement?.preview;if(!preview)return;if(deletionRequest?.token!==preview.token)deletionRequest={token:preview.token,requestId:crypto.randomUUID()};control({op:'session-delete-confirm',id:preview.id,...deletionRequest,confirmation:el('session-confirmation').value});};
}
if(el('autonomy-enabled')){
  for(const id of ['autonomy-enabled','learning-enabled','search-enabled','search-provider','search-endpoint','proactive-enabled','autonomy-quota-enabled','autonomy-tokens','autonomy-requests'])el(id).oninput=()=>{autonomyDraftDirty=true;autonomyDraftRevision++;};
  el('autonomy-save').onclick=()=>control({op:'autonomy-configure',settings:{enabled:el('autonomy-enabled').checked,learningEnabled:el('learning-enabled').checked,searchEnabled:el('search-enabled').checked,searchProvider:el('search-provider').value,searchEndpoint:el('search-endpoint').value.trim(),proactiveEnabled:el('proactive-enabled').checked,quotaEnabled:el('autonomy-quota-enabled').checked,tokenLimit:Number(el('autonomy-tokens').value),requestLimit:Number(el('autonomy-requests').value)}});
  el('learning-source-add').onclick=()=>{const url=el('learning-url').value.trim(),topic=el('learning-topic').value.trim();if(url&&topic)control({op:'autonomy-configure',settings:{sources:[...(lastState?.autonomy?.settings.sources??[]),{url,topic,title:topic.slice(0,100)}]}});};
  el('autonomy-pause').onclick=()=>control({op:'autonomy-pause'});el('autonomy-resume').onclick=()=>control({op:'autonomy-resume'});
  if(el('autonomy-task-retry'))el('autonomy-task-retry').onclick=()=>{const task=lastState?.autonomy?.tasks.find(t=>t.status==='failed');if(task)control({op:'autonomy-retry-task',taskId:task.id});};
  el('autonomy-grant').onclick=()=>control({op:'autonomy-grant',mode:el('grant-mode').value,tokens:Number(el('grant-tokens').value),requests:Number(el('grant-requests').value),days:Number(el('grant-days').value)});
}
controls();refresh();setInterval(refresh,1500);
