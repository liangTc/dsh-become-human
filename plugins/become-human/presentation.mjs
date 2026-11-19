import {replyParts} from './reply-parts.mjs';
import {conversationSettings} from './owner-turns.mjs';

// Presentation only; one durable assistant event remains the canonical reply.
export function replyPresentation(journal,agent,event,text){
  const settings=conversationSettings(journal,agent);
  const request=(event&&journal.db.prepare(`SELECT json_extract(request,'$.lane') AS lane,
    json_extract(request,'$.taskId') AS taskId,json_extract(request,'$.ownerInputRevision') AS ownerInputRevision,
    json_extract(request,'$.pauseRevision') AS pauseRevision,json_extract(request,'$.admittedIds') AS admittedIds
    FROM attempt WHERE agent=? AND turn=? ORDER BY started DESC LIMIT 1`).get(agent,event.data.turn))||{};
  const task=request.taskId?journal.db.prepare('SELECT kind FROM autonomy_task WHERE agent=? AND id=?').get(agent,request.taskId):null;
  const eligible=request.lane==='foreground'||request.lane==='executor'&&['chat','care','share-insight'].includes(task?.kind);
  const parts=replyParts(text,{enabled:settings.replyBubbles&&eligible});
  let ownerInputRevision=request.ownerInputRevision;
  if(!Number.isSafeInteger(ownerInputRevision))ownerInputRevision=JSON.parse(request.admittedIds??'[]').reduce((n,id)=>Math.max(n,journal.db.prepare('SELECT rowid AS n FROM user_request WHERE agent=? AND message_id=?').get(agent,id)?.n??0),0);
  return {kind:eligible?'chat-bubbles':'whole-message',parts,gapMs:settings.replyGapMs,ownerInputRevision,pauseRevision:request.pauseRevision??0,autonomous:request.lane!=='foreground'};
}
