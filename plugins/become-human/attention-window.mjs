// Fair visibility, not a rule deciding which action the model must execute.
// Readers preview the same window; only a new scheduler scan advances it.
export function attentionWindow(journal,agent,scope,entries,{limit=16,advance=false,perGroupLimit=limit}={}){
  if(!['plugin-events','behavior-opportunities'].includes(scope)||!Number.isInteger(limit)||limit<1||limit>32||entries.length>4096)throw Error('INVALID_ATTENTION_WINDOW');
  const unique=new Map();
  for(const entry of entries){
    if(typeof entry.key!=='string'||!entry.key||typeof entry.group!=='string'||!entry.group)throw Error('INVALID_ATTENTION_ENTRY');
    if(!unique.has(entry.key))unique.set(entry.key,entry);
  }
  const prior=journal.db.prepare('SELECT entry,seen FROM human_attention_window WHERE agent=? AND scope=?').all(agent,scope),seen=new Map(prior.map(row=>[row.entry,row.seen]));
  const groups=new Map();let index=0;
  for(const entry of unique.values()){
    if(!groups.has(entry.group))groups.set(entry.group,{key:entry.group,index,rows:[]});
    groups.get(entry.group).rows.push({...entry,index:index++});
  }
  const ordered=[...groups.values()].sort((a,b)=>(seen.get('group:'+a.key)??0)-(seen.get('group:'+b.key)??0)||a.index-b.index);
  for(const group of ordered)group.rows.sort((a,b)=>(seen.get('item:'+a.key)??0)-(seen.get('item:'+b.key)??0)||a.index-b.index);
  const selected=[];
  for(let pass=0;selected.length<limit;pass++){
    let added=false;
    for(const group of ordered){if(pass<perGroupLimit&&group.rows[pass]){selected.push(group.rows[pass]);added=true;}if(selected.length===limit)break;}
    if(!added)break;
  }
  if(advance)journal.transaction(()=>{
    const active=new Set([...unique.keys()].map(key=>'item:'+key).concat([...groups.keys()].map(key=>'group:'+key)));
    const remove=journal.db.prepare('DELETE FROM human_attention_window WHERE agent=? AND scope=? AND entry=?');
    for(const row of prior)if(!active.has(row.entry))remove.run(agent,scope,row.entry);
    let round=Math.max(0,...prior.map(row=>row.seen));
    const put=journal.db.prepare('INSERT INTO human_attention_window VALUES(?,?,?,?) ON CONFLICT(agent,scope,entry) DO UPDATE SET seen=excluded.seen');
    // Unique positions avoid persistent tie bias toward earlier providers.
    for(const row of selected){round++;put.run(agent,scope,'item:'+row.key,round);put.run(agent,scope,'group:'+row.group,round);}
  });
  return selected.map(({index,...entry})=>entry);
}
