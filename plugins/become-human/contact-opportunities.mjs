export const careQuestion='结合当前人物与关系设定、有效记忆和目标，选择一个值得向主人了解的近况或生活问题。不要默认恋爱关系或称谓；没有新话题就等待。';
export function collectContactOpportunities(agent,{settings,offer,contactReady,anchor}){
  if(settings.proactiveEnabled&&contactReady&&!settings.socialEnabled&&agent.factory.journal.value(agent.id,'care-user-anchor',null)!==anchor)
    offer({kind:'care',anchor,question:careQuestion});
}
