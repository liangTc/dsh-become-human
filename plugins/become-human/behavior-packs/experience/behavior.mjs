// This package owns behavior policy, while Human retains evidence and authority.
export function createExperienceBehavior(access){
 const object=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
 return {version:1,title:'回顾经历与调整方法',description:'从实际经历中提炼一个暂定认识和下次方法；可承担有期限的阶段角色，不改变基础身份或任何权限。',
  inputSchema:object({experienceIds:{type:'array',items:{type:'string',minLength:1,maxLength:128},minItems:1,maxItems:8},lesson:{type:'string',minLength:1,maxLength:400},nextApproach:{type:'string',minLength:1,maxLength:400},role:object({label:{type:'string',minLength:1,maxLength:200},purpose:{type:'string',minLength:1,maxLength:200},expiresAt:{type:'integer',minimum:1}},['label','purpose','expiresAt'])},['experienceIds','lesson','nextApproach']),
  opportunities:agent=>{const experience=access(agent),fresh=experience.recent({limit:8}).filter(row=>row.data.receipt.behaviorId!=='reflect-experience'&&!experience.hasReflection(row.id));return fresh.some(row=>row.data.receipt.status==='failed')||fresh.length>=3?[{question:'回顾最近真实经历，决定是否需要改变方法、关注方向或阶段角色。'}]:[];},
  execute:async(agent,input,{task,valid})=>{valid();const row=access(agent).reflect({requestId:'task:'+task.id,...input});return {status:'completed',summary:row.data.lesson,reflectionId:row.id};}
 };
}
