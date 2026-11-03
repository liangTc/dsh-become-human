// No I/O, timer or independent model loop. Only the selected task may read.
export function collect({settings,now,sources,lastResearchAt}){
  if(!settings.learningEnabled)return [];
  const rows=sources.filter(s=>now-s.checkedAt>=settings.sourceIntervalMs&&!s.declined).map(s=>({kind:'learn-ai',question:s.spec.topic,sourceSpec:s.spec,correction:s.correction}));
  if(settings.searchEnabled&&now-lastResearchAt>=settings.sourceIntervalMs)rows.push({kind:'research',question:'根据当前人格、有效经历、兴趣和目标，提出一个值得了解的小问题；也可以不学习。'});
  return rows;
}
