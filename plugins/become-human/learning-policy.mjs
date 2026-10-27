// Learning intent is an accountable plan, not proof of consciousness or value.
// Publication is a separate, opt-in conversation decision.
import {insightResult,agentExperienceRisk} from './learning.mjs';

export const learningPolicyVersion=3;
export const learningIntentExample=Object.freeze({motive:'curiosity',gap:'目前缺少什么具体认识',selfBenefit:'对当前人物能力或兴趣有什么具体帮助',userBenefit:'对主人可能有什么用；无直接用途也可如实说明',expectedUse:'准备如何使用，而不是必定发给主人',stopWhen:'得到什么就停止，或何种情况不再投入'});
export const learningIntentPolicy='学习前先回答为什么现在值得学，而不是学完找理由。只选一个能在本轮回答的小问题：服务有效目标、主人真实提出的问题、当前人物的真实兴趣，或阻碍下一步的能力缺口。说明现有知识缺口、对自己的用途、对主人的可能用途、准备如何使用及停止条件。人物自己的好奇可以没有即时用户收益，不编造主人需求，不把自己的兴趣说成共同兴趣，也不以能发消息作为学习价值。人物的兴趣不等于主人的兴趣。userBenefit只写潜在用途或如实说明没有即时收益，不用主人已经喜欢、讨厌、偏爱、爱喝、爱吃、需要或想要某事来证明学习价值；可写如果以后主人需要相关信息时能提供什么帮助，或说明不假定主人有该偏好。优先可应用、能纠正旧认识或补足实际问题的内容；降低重复资料、脱离当前关系和目标的孤立术语、没有证据的前沿噱头、仅为保持活跃的学习。已有笔记能回答就先用，不重复抓取；无法得到有用证据、主题被拒绝或达到本轮边界就等待。只读取公开资料及已有授权范围，不因好奇自行增加工具、私有数据、消费或行动权限。搜索摘要只是线索，正文与原始文档才是可引用证据；遇到冲突保留分歧，未知日期不声称最新。';
export const learningInvitationPolicy='这是一次轻轻带起话题的引子，不是知识推送或报告。只用一至两个短句、最多120字，依照当前人格自然提起最近学的一个方向，必要时说一个真实的兴趣点或与生活/目标的联系；允许只说自己在琢磨什么，给对方接话的空间，不规定必须说“想听吗”。不直接输出整段结论、术语解释、证据边界清单、链接、路径或内部编号，不强迫对方回答或学习。只能提实际保存且来源有效的笔记，可以说实际在读、在学、在琢磨资料，不能为拟人化编造刚在磨豆、冲咖啡、做饭或去过店等线下经历；不虚构共同兴趣，没有自然理由值得提起就 [WAIT]。后续仅在主人明确追问本话题时展开；没有追问就停，不解释成讨厌或制造愧疚。';

export function learningOrigin(task){
  return task.checkpoint.learningOrigin??(task.checkpoint.goal?'owner-goal':task.checkpoint.matterId?'active-matter':task.checkpoint.source&&!task.checkpoint.source.discovery?'configured-source':'persona-curiosity');
}
function ownerPreferenceAsPurpose(text){
  // This bounded lexical check catches direct owner-attribution phrases only.
  // It does not prove semantic entailment or validate an owner's preferences.
  for(const clause of text.split(/[。！？!?；;\n]/u)){
    const claims=/(主人|用户|你|您|对方)((?:(?:目前|现在|之前|以前|曾经|说过|表示|明确表示|已经确认|确认|明确|已|本来|本就|一直|向来|平时|通常|总是|其实|真的|显然|似乎|可能|一定|确实|比较|特别|非常|已经|很|更|最|还|也|都|就|会|并不|并未|没有|不|没|未|是否|若|如果|假如)\s*)*)(喜欢|讨厌|偏爱|爱喝|爱吃|需要|想要|感兴趣)/gu;
    for(const match of clause.matchAll(claims)){
      const boundary=Math.max(clause.lastIndexOf('，',match.index),clause.lastIndexOf(',',match.index))+1;
      const prefix=clause.slice(boundary,match.index)+match[1]+match[2];
      if(/若|如果|假如/u.test(prefix)||match[2].includes('是否'))continue;
      if(/不(?:应|会|能|要|可)?(?:假定|假设|推断|推定|认为|预设|认定|断言|要求|强求)|不代表|不意味着|不能说明|未知是否|不(?:清楚|知道|确定)|尚未确认|未确认/u.test(prefix))continue;
      return true;
    }
  }
  return false;
}
export function validateLearningIntent(plan,task){
  const value=plan.learningIntent;
  const invalid=(field,reason,details={})=>{throw Object.assign(new Error('INVALID_TASK_OUTPUT'),{validationDiagnostic:{field:'learningIntent'+(field?'.'+field:''),reason,...details}});};
  if(!value||typeof value!=='object'||Array.isArray(value))invalid('','object-required',{present:Object.hasOwn(plan,'learningIntent'),actualType:value===null?'null':Array.isArray(value)?'array':typeof value});
  if(Object.keys(value).some(k=>!['motive','gap','selfBenefit','userBenefit','expectedUse','stopWhen'].includes(k)))invalid('','unexpected-fields');
  if(!['goal','question','curiosity','capability'].includes(value.motive))invalid('motive','invalid-enum-value');
  for(const field of ['gap','selfBenefit','userBenefit','expectedUse','stopWhen'])if(typeof value[field]!=='string'||!value[field].trim()||value[field].length>240)invalid(field,'bounded-purpose-required');
  if(ownerPreferenceAsPurpose(value.userBenefit))invalid('userBenefit','owner-preference-as-purpose');
  return {version:1,origin:learningOrigin(task),...Object.fromEntries(Object.entries(value).map(([k,v])=>[k,v.trim()])),validation:'declared-purpose-not-outcome-proof'};
}

export function learningInvitationResult(text,options){
  const value=insightResult(text,options);if(value==='[WAIT]')return value;
  if(agentExperienceRisk(value))throw Object.assign(new Error('INVALID_PROACTIVE_OUTPUT'),{validationDiagnostic:{field:'text',reason:'unsupported-agent-experience'}});
  // Reject long outreach rather than mechanically truncating a knowledge
  // claim or splitting an unwanted report into many messages.
  if(value.length>120||/https?:\/\/|(?:[A-Z]:[\\/]|\\\\)[^\s]+|(?:^|[\s（(])\/[\w.-]+\/[\w./-]+|\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b|(?:笔记|证据|行动|任务)(?:编号|ID)\s*[:：\s]|^\s*(?:#{1,6}\s|[-*]\s|\d+[.)、])/imu.test(value))throw Object.assign(new Error('INVALID_PROACTIVE_OUTPUT'),{validationDiagnostic:{field:'text',reason:'learning-invitation-required'}});
  return value;
}
