import {createHash} from 'node:crypto';
import {goalCommand} from './goal-command.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const textOf=m=>m.content.filter(c=>c.type==='text').map(c=>c.text).join('');
const targetsUsable=(f,id,receipt)=>(receipt.goalIds??[]).every(goalId=>{try{return f.goals.get(id,goalId).sourceValid;}catch{return false;}});

// Resolve only a complete, simple calendar question. Use the configured fixed
// UTC offset and the admitted input time, so a midnight replay keeps the same
// answer. This does not interpret reminders or compound scheduling requests.
export function calendarReply(text,{now=Date.now(),offset=480}={}){
  if(typeof text!=='string'||!Number.isSafeInteger(now)||!Number.isSafeInteger(offset)||offset< -720||offset>840)return null;
  const match=/^(?:请问\s*)?(今天|明天|后天|昨天|前天)\s*(?:是\s*)?(?:星期几|周几|礼拜几)\s*[？?。！!]?\s*(?:[，,；;。]?\s*(?:请\s*)?只(?:要)?回答\s*(?:星期几|周几|礼拜几)\s*(?:就好|即可|就行)?\s*[。！!]?\s*)?$/u.exec(text.normalize('NFKC').trim());
  if(!match)return null;
  const day=({今天:0,明天:1,后天:2,昨天:-1,前天:-2})[match[1]],date=new Date(now+offset*60000+day*86400000);
  if(!Number.isFinite(date.getTime()))return null;
  return ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][date.getUTCDay()];
}

// Local commands are admitted owner inputs, never instructions found in memory
// or public material. The receipt is atomic with the command's state change.
export function directOwner(factory,id,message){
  if(message?.source?.kind!=='human'||message.role!=='user'||typeof message.id!=='string'||!Array.isArray(message.content))return false;
  const row=factory.journal.db.prepare('SELECT * FROM source_record WHERE agent=? AND id=?').get(id,message.id);
  return !!row&&row.kind==='user'&&row.namespace==='real'&&row.root===row.id&&row.body===textOf(message)&&factory.domain.sourceUsable(id,message.id);
}
export function ownerCommand(agent,message,offset){
  const f=agent.factory,j=f.journal,id=agent.id;
  if(!directOwner(f,id,message))return null;
  return j.transaction(()=>{
    j.assertAdmitted(id);const key='owner-command:'+message.id,inputHash=hash(textOf(message)),cached=j.value(id,key,null);
    if(cached){if(cached.inputHash!==inputHash)throw new Error('LOCAL_COMMAND_INPUT_CONFLICT');return targetsUsable(f,id,cached)?cached:null;}
    const event=agent.session.snapshotEvents().find(e=>e.type==='agent/inbox/spliced'&&e.data.inserted?.some(m=>m.id===message.id));
    const receivedAt=Number.isSafeInteger(event?.time)?Math.min(event.time,f.reminders.now()):f.reminders.now();
    let provider='local-reminder',text=f.reminders?.command(id,message,offset,{receivedAt});
    if(text==null){text=calendarReply(textOf(message),{now:receivedAt,offset});provider='local-calendar';}
    if(text==null){text=goalCommand(f.goals,id,message,{timeZoneOffsetMinutes:offset});provider='local-goal';}
    if(text==null)return null;
    const receipt={inputId:message.id,inputHash,messageId:crypto.randomUUID(),provider,text,receivedAt,goalIds:provider==='local-goal'?j.value(id,'goal-command:'+message.id,null)?.goalIds??[]:[],created:Date.now()};
    j.put(id,key,receipt);j.audit(id,'owner-command-recorded',{inputId:message.id,messageId:receipt.messageId,command:provider,origin:'owner',lane:'foreground'});return receipt;
  });
}
export function pendingOwnerCommand(agent){
  const f=agent.factory,j=f.journal,id=agent.id,events=agent.session.snapshotEvents(),sent=new Set(events.filter(e=>e.type==='assistant/message').map(e=>e.data.message.id));
  for(const row of j.db.prepare("SELECT value FROM metadata m WHERE agent=? AND key LIKE 'owner-command:%' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.agent=m.agent AND o.event_key='assistant:'||json_extract(m.value,'$.messageId')) ORDER BY json_extract(value,'$.created'),key").iterate(id)){
    const receipt=JSON.parse(row.value);if(sent.has(receipt.messageId))continue;
    const message=events.find(e=>e.type==='user/message'&&e.data.id===receipt.inputId)?.data;
    if(message&&directOwner(f,id,message)&&targetsUsable(f,id,receipt)&&receipt.inputHash===hash(textOf(message)))return {receipt,message};
  }
  return null;
}
