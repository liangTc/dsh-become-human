import {routeDisposition} from './learning-engagement.mjs';
import {checkpointForOpportunity} from './behavior-selection.mjs';
export const careQuestion='结合当前人物与关系设定、有效记忆和目标，选择一个值得向主人了解的近况或生活问题。不要默认恋爱关系或称谓；没有新话题就等待。';
// Communication eligibility and share-candidate cursor remain separate from learning.
export function collectContactOpportunities(agent,{settings,now,offer,contactReady,anchor}){
 const store=agent.factory.autonomy,j=agent.factory.journal,id=agent.id;
  if(settings.proactiveEnabled&&contactReady){
    if(settings.learningEnabled){
    let cursor=j.value(id,'learningShareScanCursor',null),found=false;
    for(let page=0;page<5&&!found;page++){
      const candidates=store.shareCandidates(id,{limit:20,cursor});
      for(const note of candidates.items){const disposition=routeDisposition(j,agent.factory.domain,id,(note.data.researchQuestion??'')+' '+note.data.title,now);if(disposition.cooldownUntil>now)continue;const next={kind:'share-insight',noteId:note.id,question:'围绕已有笔记 '+note.data.title+' 自然带起一个话题，先给引子，不推送知识正文。'};if(store.deferred(id,checkpointForOpportunity(next),now))continue;offer(next);found=true;break;}
      cursor=found?null:candidates.nextCursor;if(!cursor)break;
    }
    j.put(id,'learningShareScanCursor',cursor);
    }
    if(!settings.socialEnabled&&j.value(id,'care-user-anchor',null)!==anchor)offer({kind:'care',anchor,question:careQuestion});
  }
}
