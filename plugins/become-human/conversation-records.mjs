// Read the durable, user-visible conversation, never provider prompts or reasoning.
const fail=()=>{throw new Error('INVALID_CONVERSATION_QUERY');};
const parse=value=>{try{return JSON.parse(value)??{};}catch{return {};}};
const cursor=value=>value===undefined?undefined:Number.isSafeInteger(value)&&value>0?value:fail();
export function conversationRecords(factory,id,input={}){
  factory.journal.assertAdmitted(id);
  const db=factory.journal.db,limit=input.limit??40,before=cursor(input.before),requestedCeiling=cursor(input.ceiling);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||typeof(input.query??'')!=='string'||(input.query??'').length>160||!['all','user','assistant','system'].includes(input.role??'all'))fail();
  const args=[id],where=['o.agent=?'],query=(input.query??'').trim(),role=input.role??'all';
  const ceiling=requestedCeiling??db.prepare('SELECT max(seq) AS n FROM outbox WHERE agent=?').get(id).n??0;
  where.push('o.seq<=?');args.push(ceiling);
  if(before){where.push('o.seq<?');args.push(before);}
  if(query){where.push('instr(lower(o.text),lower(?))>0');args.push(query);}
  if(role!=='all'){where.push(role==='system'?"o.kind NOT IN ('user','assistant')":'o.kind=?');if(role!=='system')args.push(role);}
  if(input.taskId!==undefined){
    if(typeof input.taskId!=='string'||!input.taskId||input.taskId.length>200)fail();
    // Only durable response associations count. Temporal proximity is not a link.
    const keys=new Set();
    const link=(messageId,inputIds)=>{if(typeof messageId==='string'&&messageId)keys.add('assistant:'+messageId);for(const mid of Array.isArray(inputIds)?inputIds:[])if(typeof mid==='string')keys.add('user:'+mid);};
    // response_stage.payload is intentionally cleared after commit. The origin
    // metadata survives compaction and links a published message to its attempt.
    const origins=db.prepare(`SELECT m.key,m.value FROM metadata m JOIN attempt a ON a.agent=m.agent AND a.id=json_extract(CASE WHEN json_valid(m.value) THEN m.value ELSE '{}' END,'$.attemptId') WHERE m.agent=? AND m.key LIKE 'dialogue-origin:%' AND json_valid(a.request) AND json_extract(a.request,'$.taskId')=?`).all(id,input.taskId);
    for(const row of origins){const origin=parse(row.value);link(row.key.slice('dialogue-origin:'.length),origin.inputIds);}
    // Older records may predate origin metadata. Keep only explicit retained
    // publication events; never infer association from time or message order.
    for(const row of db.prepare("SELECT data FROM human_event WHERE agent=? AND task_id=? AND kind='response-published'").all(id,input.taskId)){const event=parse(row.data);link(event.messageId,event.inputId?[event.inputId]:[]);}
    if(!keys.size)return {sessionId:id,items:[],hasMore:false,nextBefore:null,ceiling,scope:'durable-published-messages',linkedOnly:true};
    where.push('o.event_key IN (SELECT value FROM json_each(?))');args.push(JSON.stringify([...keys]));
  }
  const rows=db.prepare(`SELECT o.seq,o.kind,o.text,o.created,o.event_key FROM outbox o WHERE ${where.join(' AND ')} ORDER BY o.seq DESC LIMIT ?`).all(...args,limit+1),hasMore=rows.length>limit,selected=rows.slice(0,limit);
  const items=selected.reverse().map(({event_key,...row})=>{
    const messageId=event_key?.startsWith('user:')?event_key.slice(5):event_key?.startsWith('assistant:')?event_key.slice(10):null;
    const request=row.kind==='user'&&messageId?db.prepare('SELECT request_id FROM user_request WHERE agent=? AND message_id=?').get(id,messageId):null;
    const origin=request?factory.journal.value(id,'origin:'+request.request_id,'web'):row.kind==='assistant'?'agent':'system';
    const association=row.kind==='assistant'&&messageId?factory.journal.value(id,'dialogue-origin:'+messageId,null):null;
    return {...row,origin,messageId,replyTo:Array.isArray(association?.inputIds)?association.inputIds:[],attachments:row.kind==='user'&&messageId?factory.media?.messageDescriptors(id,messageId)??[]:[]};
  });
  return {sessionId:id,items,hasMore,nextBefore:hasMore?items[0].seq:null,ceiling,scope:'durable-published-messages',linkedOnly:input.taskId!==undefined};
}
