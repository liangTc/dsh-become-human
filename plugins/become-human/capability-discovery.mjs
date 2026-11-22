import {retrievalTerms} from './knowledge-signals.mjs';

const normalize=value=>String(value??'').normalize('NFKC').toLowerCase();

// Ranking changes which schemas the model sees first. Only the live executor
// catalog determines which tools can actually be used.
export function matchingCapabilities(catalog,query,limit){
  const text=normalize(query);
  const terms=retrievalTerms(text,{expand:false,limit:48});
  if(!terms.length)return [];
  return catalog.map(entry=>{
    const id=normalize(entry.id),title=normalize(entry.title),description=normalize(entry.description);
    let score=text.includes(id)?1000:0;
    for(const term of terms){
      if(id.includes(term)||title.includes(term))score+=4;
      else if(description.includes(term))score++;
    }
    return {entry,score};
  }).filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(row=>row.entry);
}

export function dialogueCapabilityView(catalog,query,requestedIds=[]){
  const matches=matchingCapabilities(catalog,query,3);
  const detailed=new Set([...matches.map(row=>row.id),...requestedIds]);
  return {
    capabilityCatalog:catalog.filter(row=>detailed.has(row.id)),
    capabilityIndex:catalog.filter(row=>!detailed.has(row.id)).map(({id,title,description,effect})=>({
      id,effect,hint:(title&&title!==id?title:description??id).slice(0,64),
    })),
  };
}
