// Compatibility storage adapter. UI and workflow policy belong to the optional
// learning package; this narrow adapter preserves existing notes and settings.
export const learningSettingKeys=['learningEnabled','searchEnabled','searchProvider','searchEndpoint','sourceIntervalMs','sources','goalAutoActivateEnabled'];
export function learningRead(factory,id,input={}){
  const {journal,autonomy,management}=factory,db=journal.db;
  if(input.kind==='settings')return {settings:Object.fromEntries(learningSettingKeys.map(k=>[k,autonomy.settings(id)[k]])),revision:management.revision(id)};
  if(input.kind==='notes'){
    const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error('INVALID_PAGINATION');
    const where="agent=? AND status<>'deleted'",total=db.prepare('SELECT count(*) n FROM learning_note WHERE '+where).get(id).n;
    const items=db.prepare('SELECT id,status,created,data,feedback FROM learning_note WHERE '+where+' ORDER BY created DESC,id DESC LIMIT 8 OFFSET ?').all(id,offset).map(r=>{const d=JSON.parse(r.data);return {id:r.id,status:r.status,created:r.created,title:d?.title??'学习笔记',summary:String(d?.summary??'').slice(0,800),feedback:r.feedback?JSON.parse(r.feedback):null};});
    return {items,total,offset};
  }
  if(input.kind==='note'){
    const row=db.prepare("SELECT * FROM learning_note WHERE agent=? AND id=? AND status<>'deleted'").get(id,input.noteId);if(!row)throw Error('LEARNING_NOTE_NOT_FOUND');const d=JSON.parse(row.data);
    return {id:row.id,status:row.status,title:d.title,summary:String(d.summary??'').slice(0,3000),ownerRevision:d.ownerRevision??null,learningIntent:d.learningIntent?Object.fromEntries(['gap','selfBenefit','userBenefit','expectedUse','stopWhen'].map(k=>[k,String(d.learningIntent[k]??'').slice(0,400)])):null,source:{title:d.source?.title,url:d.source?.url},history:management.read(id,{kind:'note-history',noteId:row.id}).slice(0,3).map(r=>({...r,data:{summary:String(r.data.summary??'').slice(0,600)}}))};
  }
  throw Error('INVALID_LEARNING_READ');
}
export async function learningWrite(factory,id,input){
  if(input.operation==='settings'){
    factory.management.check(id,input.revision);
    if(!input.settings||Object.keys(input.settings).some(k=>!learningSettingKeys.includes(k)))throw Error('INVALID_LEARNING_CONFIGURATION');
    await factory.autonomy.configure(id,input.settings);factory.management.bump(id,'learning-configured');
    return learningRead(factory,id,{kind:'settings'});
  }
  if(input.operation==='annotate')factory.management.noteRevision(id,{noteId:input.noteId,expectedVersion:input.expectedVersion,summary:input.summary});
  else if(input.operation==='feedback'){factory.autonomy.feedback(id,input.noteId,input.value,input.comment??'');factory.goals.reconcile(id);}
  else throw Error('INVALID_LEARNING_OPERATION');
  return learningRead(factory,id,{kind:'note',noteId:input.noteId});
}
