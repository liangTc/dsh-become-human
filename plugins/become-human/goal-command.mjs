import {createHash} from 'node:crypto';

const labels={proposed:'待确认',active:'推进中',paused:'已暂停',blocked:'等待处理','needs-evidence':'需要补证','awaiting-review':'等待主人验收',completed:'验收已达成',cancelled:'已取消',expired:'已到期',pending:'待执行',running:'执行中',failed:'失败','awaiting-approval':'报告等待单独批准'};
const digest=value=>createHash('sha256').update(value).digest('hex');
const clip=(value,max=100)=>Array.from(String(value??'')).slice(0,max).join('');
const usage='可发 /goals 查看；/goal <ID> 查看价值、执行与验收；/goal confirm|pause|cancel|retry <ID> 操作；/goal accept <ID> 明确验收；/goal reject <ID> 补证意见；/goal gap <已确认研究问题> 提出知识缺口目标。也可说“确认目标 <ID>”或“验收目标 <ID>”。';
export function parseGoalCommand(text){
  const t=text.normalize('NFKC').trim();let match;
  if(/^\/goals(?:\s*)$/iu.test(t)||/^(?:请)?(?:查看目标(?:列表)?|有哪些目标|目标进展)[。？?！!]?$/u.test(t))return {action:'list'};
  if((match=/^\/goal(?:\s+([\s\S]*))?$/iu.exec(t))){const args=(match[1]??'').trim().split(/\s+/u).filter(Boolean);if(!args.length)return {action:'list'};if(args.length===1&&/^(?:help|帮助)$/iu.test(args[0]))return {action:'help'};if(args.length>=2&&/^gap$/iu.test(args[0]))return {action:'gap',question:args.slice(1).join(' ')};if(args.length>=3&&/^reject$/iu.test(args[0]))return {action:'reject',ref:args[1],comment:args.slice(2).join(' ')};if(args.length===1&&!/^(?:confirm|activate|pause|cancel|retry|accept|review|reject|gap)$/iu.test(args[0]))return {action:'show',ref:args[0]};if(args.length===2&&/^(?:show|confirm|activate|pause|cancel|retry|accept|review)$/iu.test(args[0]))return {action:/^(?:accept|review)$/iu.test(args[0])?'review':args[0].toLowerCase()==='activate'?'confirm':args[0].toLowerCase(),ref:args[1]};return {action:'help'};}
  if((match=/^(?:请)?(查看|确认|激活|暂停|取消|重试|验收)(?:这个|该)?目标(?:\s+([0-9a-f-]{4,36}))?[。？?！!]?$/iu.exec(t)))return {action:({查看:'show',确认:'confirm',激活:'confirm',暂停:'pause',取消:'cancel',重试:'retry',验收:'review'})[match[1]],ref:match[2]};
  return null;
}
const formatted=(time,offset)=>new Date(time+offset*60000).toISOString().slice(0,19).replace('T',' ')+` UTC${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`;
function sourceEligible(engine,agent,message,text){
  if(message?.role!=='user'||message?.source?.kind!=='human'||typeof message.id!=='string'||!message.id||message.id.length>128)return false;
  const source=engine.db.prepare("SELECT id,root,body FROM source_record WHERE agent=? AND id=? AND kind='user' AND namespace='real' AND status='active'").get(agent,message.id);
  return !!source&&source.root===source.id&&source.body===text&&engine.domain.sourceUsable(agent,message.id);
}
function resolve(engine,agent,ref){
  if(typeof ref!=='string'||!/^[0-9a-f-]{4,36}$/iu.test(ref))return {error:'请明确目标 ID，可先发送 /goals 查看。确认时请使用“确认目标 <ID>”。'};
  const exact=engine.db.prepare('SELECT g.id FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id AND p.agent=g.agent WHERE g.agent=? AND lower(g.id)=?').get(agent,ref.toLowerCase());
  const rows=exact?[exact]:engine.db.prepare('SELECT g.id FROM goal_record g JOIN human_goal_plan p ON p.goal=g.id AND p.agent=g.agent WHERE g.agent=? AND lower(g.id) LIKE ? ORDER BY g.id LIMIT 6').all(agent,ref.toLowerCase()+'%');
  if(!rows.length)return {error:'没有找到这个目标。请发送 /goals 核对当前会话的目标 ID。'};
  if(rows.length>1)return {goalIds:rows.map(r=>r.id),error:'这个短 ID 对应多个目标，请明确完整 ID：\n'+rows.map(r=>{const g=engine.get(agent,r.id);return r.id+' · '+clip(g.description,70);}).join('\n')+'\n本次没有修改任何目标。'};
  return {id:rows[0].id};
}
function show(engine,agent,id,offset){
  const g=engine.get(agent,id);return [`目标 ${g.id}`,g.description,`${labels[g.status]??g.status} · 执行 ${g.progress.completed}/${g.progress.total} 步 · 优先级 ${g.priority} · 到期 ${formatted(g.expires,offset)}`,...(g.expectedValue?['预期价值：'+g.expectedValue]:[]),...g.steps.map((s,n)=>`${n+1}. ${s.status==='completed'?'步骤已完成':labels[s.status]??s.status} · ${clip(s.question,180)}${s.noteId?' · 已保存来源笔记':''}${s.actionId?' · 报告动作 '+s.actionId:''}${s.receipt?.sha256?' · 文件哈希 '+s.receipt.sha256:''}`),...(g.reason?[`等待原因：${g.reason}${g.retryAt?'；最早重试 '+formatted(g.retryAt,offset):''}`]:[]),...(g.status==='proposed'?[`如要推进，请明确发送：确认目标 ${g.id.slice(0,8)}`]:[]),...(g.steps.some(s=>s.kind==='write-report'&&s.status!=='completed')?['报告草稿需在动作详情单独批准写入。']:[]),...(g.evaluation?[`验收：有效笔记 ${g.evaluation.noteCount}/${g.acceptance.minNotes}；不同站点与内容来源 ${g.evaluation.independentSourceCount}/${g.acceptance.minIndependentSources}。`,...g.evaluation.unmet.map(item=>'尚未满足：'+clip(item.label,180)),g.evaluation.scope]:[]),...(g.status==='awaiting-review'?[`检查结果后明确验收：/goal accept ${g.id.slice(0,8)}`]:[])].join('\n');
}
function list(engine,agent){
  const rows=engine.list(agent,{limit:128}).sort((a,b)=>Number(['completed','cancelled','expired'].includes(a.status))-Number(['completed','cancelled','expired'].includes(b.status))||b.priority-a.priority||b.created-a.created).slice(0,8);
  if(!rows.length)return {goalIds:[],reply:'当前没有分步目标。学习后的建议会保持待确认；也可在 Web 目标面板添加。'};
  return {goalIds:rows.map(r=>r.id),reply:'当前会话的目标：\n'+rows.map(g=>`${g.id.slice(0,8)} · ${labels[g.status]??g.status} · 执行 ${g.progress.completed}/${g.progress.total} · 优先级 ${g.priority} · ${clip(g.description,110)}`).join('\n')+'\n查看价值与未满足项：/goal <ID>；确认推进：确认目标 <ID>；验收：/goal accept <ID>。低风险自动激活仅在明确预授权启用后生效。'};
}
function action(engine,agent,command,offset,ownerSourceId){
  engine.reconcile(agent);if(command.action==='help')return {reply:usage};if(command.action==='list')return list(engine,agent);
  if(command.action==='gap'){try{const g=engine.proposeFromGap(agent,{question:command.question,refs:[ownerSourceId]},{enabled:true});return {goalId:g.id,goalIds:[g.id],status:g.status,reply:`已从你明确提出的问题建立目标 ${g.id.slice(0,8)}，当前${labels[g.status]??g.status}。查看价值与验收条件：/goal ${g.id.slice(0,8)}。`};}catch(error){if(!['INVALID_GOAL','GOAL_LIMIT','GOAL_GAP_REQUIRES_OWNER_SOURCE'].includes(error.message))throw error;return {reply:'未建立知识缺口目标，请明确提供180字以内的研究问题，并检查当前目标数量。',error:error.message};}}
  const resolved=resolve(engine,agent,command.ref);if(resolved.error)return {goalIds:resolved.goalIds??[],reply:resolved.error};const g=engine.get(agent,resolved.id),base={goalId:g.id,goalIds:[g.id]};
  if(command.action==='show')return {...base,reply:show(engine,agent,g.id,offset)};
  if(command.action==='confirm'&&g.status==='active')return {...base,reply:`目标 ${g.id.slice(0,8)} 已在推进中；本次没有重复激活。`};
  if(command.action==='pause'&&g.status==='paused')return {...base,reply:`目标 ${g.id.slice(0,8)} 已暂停；原任务检查点保留。`};
  if(command.action==='cancel'&&g.status==='cancelled')return {...base,reply:`目标 ${g.id.slice(0,8)} 已取消；本次没有重复修改。`};
  if(command.action==='review'&&g.status==='completed')return {...base,reply:`目标 ${g.id.slice(0,8)} 已达到配置的验收条件。`};
  try{
    if(['review','reject'].includes(command.action)){const updated=engine.review(agent,g.id,{expectedVersion:g.version,accepted:command.action==='review',comment:command.comment??''});return {...base,status:updated.status,reply:command.action==='review'?`已明确验收目标 ${g.id.slice(0,8)}；配置的证据与主人验收条件已满足，现实效果仍需另行核对。`:`已记录目标 ${g.id.slice(0,8)} 的补证意见。请在网页修订有限计划，原失败任务不会自动重试。`};}
    const updated=command.action==='retry'?engine.retry(agent,g.id,{expectedVersion:g.version}):engine.transition(agent,g.id,command.action==='confirm'?'activate':command.action,{expectedVersion:g.version});
    const report=g.steps.some(s=>s.kind==='write-report'),retryReport=g.steps.find(s=>s.status==='failed')?.kind==='write-report';
    const reply=command.action==='confirm'?`已确认目标 ${g.id.slice(0,8)}：${clip(g.description,180)}。将由现有自主执行通道按当前学习、搜索与额度设置推进。${report?'报告仅准备草稿，写文件仍需单独批准。':''}`:command.action==='pause'?`已暂停目标 ${g.id.slice(0,8)}，原任务检查点保留。`:command.action==='cancel'?`已取消目标 ${g.id.slice(0,8)}；不会继续推进它。`:retryReport?`已明确授权重试目标 ${g.id.slice(0,8)} 的报告步骤；将准备新动作草稿，原失败动作保留，写文件仍需单独批准。`:`已明确授权重试目标 ${g.id.slice(0,8)} 的失败步骤；将创建新任务，原失败任务保留。`;
    return {...base,status:updated.status,reply};
  }catch(error){
    const code=error.message,reply=code==='GOAL_ACCEPTANCE_UNMET'?'证据验收仍有未满足项，尚未确认达成。请查看 /goal <ID> 并追加补证或明确修订验收条件。':code==='GOAL_NOT_REVIEWABLE'?'当前目标尚不能验收，请先查看执行进度、有效来源与状态。':code==='INVALID_GOAL_REVIEW'?'请明确提供500字以内的补证意见。':code==='GOAL_BACKOFF'?`这一步仍在退避中，最早可在 ${formatted(g.retryAt,offset)} 明确重试；旧失败任务保留。`:code==='GOAL_RETRY_REQUIRED'?'这个目标有失败或阻塞步骤，不能直接激活。请查看原因，满足条件后明确发送 /goal retry <ID>。':code==='GOAL_SOURCE_INVALID'||code==='GOAL_NOT_RETRYABLE'?'目标来源或当前步骤已不满足执行条件，未修改目标。请查看 Web 目标详情。':code==='GOAL_FINAL'?'这个目标已经完成、取消或到期，不能再激活或修改；需要新目标时请单独创建。':code==='GOAL_ATTEMPT_LIMIT'?'该步骤已达到手动重试上限，未创建新任务。':code==='STALE_GOAL'?'目标状态刚刚变化，请先发送 /goals 刷新后再确认。':code==='INVALID_GOAL_TRANSITION'?'当前目标状态不支持这个操作；请先查看 /goal <ID>。':null;
    if(!reply)throw error;return {...base,error:code,reply};
  }
}

// Call only after the normal owner lane has observed the admitted message.
// There is no model, transport, Session creation, or broader permission here.
export function goalCommand(engine,agent,message,{timeZoneOffsetMinutes=480}={}){
  if(!engine||!message||!Array.isArray(message.content))return null;
  const text=message.content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join(''),command=parseGoalCommand(text);if(!command)return null;
  engine.journal.assertAdmitted(agent);if(!sourceEligible(engine,agent,message,text))return null;
  if(!Number.isSafeInteger(timeZoneOffsetMinutes)||timeZoneOffsetMinutes< -720||timeZoneOffsetMinutes>840)throw new Error('INVALID_TIME_ZONE');
  const key='goal-command:'+message.id,hash=digest(text),cached=engine.journal.value(agent,key,null);
  if(cached){if(cached.hash!==hash)throw new Error('REQUEST_ID_CONFLICT');try{if((cached.goalIds??(cached.goalId?[cached.goalId]:[])).some(id=>!engine.get(agent,id).sourceValid))return null;}catch{return null;}return cached.reply;}
  return engine.journal.transaction(()=>{const result=action(engine,agent,command,timeZoneOffsetMinutes,message.id);engine.journal.put(agent,key,{hash,reply:result.reply,goalId:result.goalId??null,goalIds:result.goalIds??(result.goalId?[result.goalId]:[]),action:command.action,at:engine.now(agent)});engine.journal.audit(agent,'goal-command-handled',{messageId:message.id,action:command.action,goalId:result.goalId??null,status:result.status??null,error:result.error??null});return result.reply;});
}
