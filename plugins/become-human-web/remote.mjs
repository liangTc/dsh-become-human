import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {protectKey} from './runtime/dpapi.mjs';
import {EventLog} from './runtime/event-log.mjs';
import {safeOperationCode} from './operations-log.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex');
const idOk=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{2,64}$/.test(value);
export class RemoteGateway {
  constructor(file,runtime,{seal,unseal}={}){
    this.runtime=runtime;this.adapters=new Map();this.busy=false;this.closed=false;this.receiving=Promise.resolve();this.controls=Promise.resolve();this.replyBusy=false;this.lastError=null;
    this.seal=seal??(text=>protectKey('protect',Buffer.from(text).toString('hex')));this.unseal=unseal??(text=>Buffer.from(protectKey('unprotect',text),'hex').toString());
    this.db=new DatabaseSync(file);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS channel(id TEXT PRIMARY KEY,kind TEXT,config TEXT,enabled INTEGER,session TEXT,cursor INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS inbound(channel TEXT,message TEXT,hash TEXT,request_id TEXT,status TEXT,PRIMARY KEY(channel,message));
      CREATE TABLE IF NOT EXISTS delivery(channel TEXT,session TEXT,seq INTEGER,payload TEXT,state TEXT,receipt TEXT,PRIMARY KEY(channel,session,seq));
      CREATE TABLE IF NOT EXISTS delivery_part(channel TEXT,session TEXT,seq INTEGER,part INTEGER,payload TEXT,state TEXT,receipt TEXT,due_at INTEGER,gap_ms INTEGER,binding_generation INTEGER,owner_revision INTEGER,pause_revision INTEGER,autonomous INTEGER,hash TEXT,sent_at INTEGER,PRIMARY KEY(channel,session,seq,part));
      CREATE TABLE IF NOT EXISTS delivery_confirmation(channel TEXT,session TEXT,seq INTEGER,version INTEGER NOT NULL,outcome TEXT NOT NULL,confirmed_at INTEGER NOT NULL,PRIMARY KEY(channel,session,seq));
      CREATE TABLE IF NOT EXISTS preference(key TEXT PRIMARY KEY,value TEXT);`);
    if(!this.db.prepare('PRAGMA table_info(inbound)').all().some(c=>c.name==='kind'))this.db.exec("ALTER TABLE inbound ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'");
    this.events=new EventLog(this.db,'m');
    this.blockWake('cold-start');
    for(const row of this.db.prepare("SELECT channel,session,seq FROM delivery WHERE state='sending'").all())this.events.append(row.session,crypto.randomUUID(),'delivery-unknown',{channel:row.channel,messageSeq:row.seq,status:'unknown',origin:row.channel,reason:'restart-during-send'});
    this.db.prepare("UPDATE delivery SET state='unknown' WHERE state='sending'").run();
    this.db.prepare("UPDATE delivery_part SET state='unknown',receipt=?,payload=NULL WHERE state='sending'").run(JSON.stringify({code:'RESTART_DURING_SEND'}));
    for(const item of this.db.prepare('SELECT DISTINCT channel,session,seq FROM delivery_part').all())this.summarizeParts(item);
  }
  register(kind,adapter){if(typeof kind!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(kind)||this.adapters.has(kind)||typeof adapter?.verify!=='function'||typeof adapter?.send!=='function')throw new Error('INVALID_ADAPTER');this.adapters.set(kind,adapter);return ()=>this.adapters.delete(kind);}
  preference(key,value){if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO preference VALUES(?,?)').run(key,JSON.stringify(value));const row=this.db.prepare('SELECT value FROM preference WHERE key=?').get(key);return row?JSON.parse(row.value):false;}
  wakeBlock(){const stored=this.wakeBlockMemory??this.preference('wake-blocked');return stored&&typeof stored==='object'?stored:{blocked:true,reason:'cold-start',at:null};}
  blockWake(reason){const value={blocked:true,reason,at:Date.now()};this.wakeBlockMemory=value;this.preference('wake-blocked',value);return value;}
  allowWake(reason){const value={blocked:false,reason,at:Date.now()};this.preference('wake-blocked',value);this.wakeBlockMemory=value;return value;}
  queueControl(work){const current=this.controls.catch(()=>{}).then(work);this.controls=current;return current;}
  async controlRuntime(input,{automatic=false}={}){
    return this.queueControl(async()=>{
      if(this.closed)throw new Error('REMOTE_CLOSED');
      if(automatic&&(this.wakeBlock().blocked||!this.preference('reply-enabled')))return null;
      const result=await this.runtime.control(input);
      if(input.op==='pause')this.blockWake('user-pause');
      else if(!automatic&&['start','once'].includes(input.op))this.allowWake('manual-resume');
      return result;
    });
  }
  async resumeRuntime(){
    return this.queueControl(async()=>{
      if(this.closed)throw new Error('REMOTE_CLOSED');
      const state=await this.runtime.state();if(state.retiring)throw new Error('SESSION_RETIRING');
      if(state.desired==='paused'&&state.driveMode==='continuous'&&state.cycleLimit===null)await this.runtime.control({op:'start',sessionId:state.sessionId,expectedEpoch:state.cancelEpoch});
      this.allowWake('manual-resume');
      return {command:'resumed'};
    });
  }
  async restartRuntime(){
    return this.queueControl(async()=>{
      this.blockWake('runtime-restart');await this.runtime.close();this.runtime.closed=false;this.runtime.lastError=null;await this.runtime.start();
      return this.runtime.state();
    });
  }
  async stopRuntime(){return this.queueControl(async()=>{this.blockWake('runtime-stop');await this.runtime.close();return {desired:'paused',status:'stopped'};});}
  recordError(error,{operation='remote-tick',channel}={}){
    const code=safeOperationCode(error,'REMOTE_OPERATION_FAILED'),providerCode=error?.details?.providerCode??error?.providerCode,reason=error?.reason,next={at:Date.now(),code,operation,...(channel?{channel}:{}),...(typeof reason==='string'&&/^[A-Z][A-Z0-9_]{2,64}$/.test(reason)?{reason}:{}),...(typeof providerCode==='number'&&Number.isFinite(providerCode)||typeof providerCode==='string'&&/^-?\d{1,8}$/.test(providerCode)?{providerCode}:{} )},prior=this.lastError;
    this.lastError=next;try{this.preference('last-remote-error',next);}catch(storageError){this.runtime.recordLifecycle?.('remote-error-store-failed',{code:safeOperationCode(storageError,'REMOTE_ERROR_STORE_FAILED'),originalCode:code});}
    if(prior?.code!==code||prior?.channel!==channel||prior?.operation!==operation)this.runtime.recordLifecycle?.('remote-operation-failed',next);
    return next;
  }
  confirmationItem(row){
    const confirmation=this.db.prepare('SELECT version,outcome,confirmed_at FROM delivery_confirmation WHERE channel=? AND session=? AND seq=?').get(row.channel,row.session,row.seq),parse=value=>{try{return JSON.parse(value);}catch{return null;}};
    return {channel:row.channel,sessionId:row.session,seq:row.seq,state:row.state,receipt:parse(row.receipt),parts:this.db.prepare('SELECT part,state,receipt,sent_at FROM delivery_part WHERE channel=? AND session=? AND seq=? ORDER BY part').all(row.channel,row.session,row.seq).map(p=>({part:p.part,state:p.state,receipt:parse(p.receipt),sentAt:p.sent_at})),version:confirmation?.version??0,confirmation:confirmation?{outcome:confirmation.outcome,at:confirmation.confirmed_at,version:confirmation.version}:null};
  }
  async deliveryReview(input){
    const current=await this.runtime.state();if(!input.sessionId||input.sessionId!==current.sessionId)throw new Error('STALE_SESSION');if(current.retiring)throw new Error('SESSION_RETIRING');
    const limit=input.limit??25,offset=input.offset??0,resolution=input.resolution??'unresolved';
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000||!['unresolved','all','received','not-received'].includes(resolution)||input.channel!==undefined&&!idOk(input.channel))throw new Error('INVALID_DELIVERY_QUERY');
    const where=["d.session=?","d.state IN ('unknown','rejected')"],params=[current.sessionId];if(input.channel!==undefined){where.push('d.channel=?');params.push(input.channel);}if(resolution==='unresolved')where.push('c.version IS NULL');else if(resolution!=='all'){where.push('c.outcome=?');params.push(resolution);}
    const from=' FROM delivery d LEFT JOIN delivery_confirmation c ON c.channel=d.channel AND c.session=d.session AND c.seq=d.seq WHERE '+where.join(' AND '),total=this.db.prepare('SELECT count(*) AS n'+from).get(...params).n;
    const rows=this.db.prepare('SELECT d.channel,d.session,d.seq,d.state,d.receipt'+from+' ORDER BY d.seq DESC,d.channel LIMIT ? OFFSET ?').all(...params,limit,offset);
    return {sessionId:current.sessionId,items:rows.map(row=>this.confirmationItem(row)),total,hasMore:offset+rows.length<total,limit,offset};
  }
  async confirmDelivery(input){
    return this.queueControl(async()=>{
      if(this.closed)throw new Error('REMOTE_CLOSED');
      if(!idOk(input.channel)||!Number.isSafeInteger(input.seq)||input.seq<1||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!['received','not-received'].includes(input.outcome))throw new Error('INVALID_DELIVERY_CONFIRMATION');
      const current=await this.runtime.state();if(!input.sessionId||input.sessionId!==current.sessionId)throw new Error('STALE_SESSION');if(current.retiring)throw new Error('SESSION_RETIRING');
      this.db.exec('BEGIN IMMEDIATE');try{
        const row=this.db.prepare('SELECT channel,session,seq,state,receipt FROM delivery WHERE channel=? AND session=? AND seq=?').get(input.channel,current.sessionId,input.seq);if(!row)throw new Error('DELIVERY_NOT_FOUND');if(!['unknown','rejected'].includes(row.state))throw new Error('DELIVERY_NOT_REVIEWABLE');
        const item=this.confirmationItem(row);if(input.expectedVersion!==item.version){if(item.confirmation?.outcome===input.outcome&&input.expectedVersion===item.version-1){this.db.exec('COMMIT');return item;}throw new Error('STALE_DELIVERY_CONFIRMATION');}
        if(item.confirmation?.outcome===input.outcome){this.db.exec('COMMIT');return item;}
        const version=item.version+1,at=Date.now();this.db.prepare('INSERT INTO delivery_confirmation VALUES(?,?,?,?,?,?) ON CONFLICT(channel,session,seq) DO UPDATE SET version=excluded.version,outcome=excluded.outcome,confirmed_at=excluded.confirmed_at').run(row.channel,row.session,row.seq,version,input.outcome,at);
        this.events.append(row.session,crypto.randomUUID(),'delivery-owner-confirmed',{origin:'owner',channel:row.channel,messageSeq:row.seq,providerState:row.state,outcome:input.outcome,version,time:at,status:'reviewed',resend:false});
        const result=this.confirmationItem(row);this.db.exec('COMMIT');return result;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    });
  }
  channel(id){const row=this.db.prepare('SELECT * FROM channel WHERE id=?').get(id);return row?{...row,config:JSON.parse(this.unseal(row.config))}:null;}
  current(row){const fresh=this.channel(row.id);return fresh?.enabled===1&&(fresh.config.bindingGeneration??0)===(row.config.bindingGeneration??0);}
  summarizeParts(item){
    const parts=this.db.prepare('SELECT state FROM delivery_part WHERE channel=? AND session=? AND seq=? ORDER BY part').all(item.channel,item.session,item.seq);if(!parts.length)return;
    const sent=parts.filter(p=>p.state==='sent').length,total=parts.length,bad=parts.find(p=>p.state==='unknown'||p.state==='rejected');
    let state=sent===total?'sent':bad?.state??(parts.some(p=>p.state==='discarded')?(sent?'interrupted':'discarded'):'pending');
    if(bad)this.db.prepare("UPDATE delivery_part SET state='discarded',payload=NULL WHERE channel=? AND session=? AND seq=? AND state='pending'").run(item.channel,item.session,item.seq);
    this.db.prepare('UPDATE delivery SET state=?,receipt=?,payload=CASE WHEN ? THEN NULL ELSE payload END WHERE channel=? AND session=? AND seq=?').run(state,JSON.stringify({sent:state==='sent',sentParts:sent,totalParts:total,...(bad?{code:'PART_'+bad.state.toUpperCase()}:state==='interrupted'?{code:'PARTS_INTERRUPTED'}:{})}),state==='pending'?0:1,item.channel,item.session,item.seq);
  }
  discardParts(item,code){
    const result=this.db.prepare("UPDATE delivery_part SET state='discarded',payload=NULL,receipt=? WHERE channel=? AND session=? AND seq=? AND state='pending'").run(JSON.stringify({code}),item.channel,item.session,item.seq);this.summarizeParts(item);
    if(result.changes)this.events.append(item.session,crypto.randomUUID(),'delivery-parts-interrupted',{origin:item.channel,messageSeq:item.seq,status:'suspended',code});
  }
  partGuard(row,item,part,state){
    if(state.retiring||state.sessionId!==item.session||!this.current(row)||(row.config.bindingGeneration??0)!==part.binding_generation)return 'SESSION_OR_BINDING_CHANGED';
    if((state.ownerInputRevision??0)>part.owner_revision)return 'OWNER_INPUT_RECEIVED';
    if((state.pauseRevision??0)!==part.pause_revision||state.stopReason==='user'||part.autonomous&&state.autonomy?.paused)return 'OWNER_PAUSED';
    return null;
  }
  queueDelivery(row,event,state){
    const prefix=event.kind==='user'?'[我 · '+(event.origin??'Web')+'] ':'[助手] ',p=event.presentation;
    const parts=event.kind==='assistant'&&p?.kind==='chat-bubbles'&&Array.isArray(p.parts)&&p.parts.length>=2&&p.parts.length<=3&&p.parts.every(t=>typeof t==='string'&&t.trim()&&t.length<=1200)&&p.parts.join('').replace(/\s/gu,'')===event.text.replace(/\s/gu,'')&&Number.isSafeInteger(p.gapMs)&&p.gapMs>=300&&p.gapMs<=3000&&Number.isSafeInteger(p.ownerInputRevision)&&Number.isSafeInteger(p.pauseRevision)?p.parts:null;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const inserted=this.db.prepare("INSERT OR IGNORE INTO delivery VALUES(?,?,?,?,'pending',NULL)").run(row.id,row.session,event.seq,this.seal(prefix+event.text));
      if(inserted.changes&&parts)parts.forEach((text,index)=>this.db.prepare("INSERT INTO delivery_part VALUES(?,?,?,?,?,'pending',NULL,?,?,?,?,?,?,?,NULL)").run(row.id,row.session,event.seq,index,this.seal(text),index?Date.now()+p.gapMs:Date.now(),p.gapMs,row.config.bindingGeneration??0,p.ownerInputRevision,p.pauseRevision,p.autonomous?1:0,digest(text)));
      this.db.prepare('UPDATE channel SET cursor=? WHERE id=?').run(event.seq,row.id);this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async sendPart(row,adapter,item,part){
    let fresh=await this.runtime.state();const guard=this.partGuard(row,item,part,fresh);if(guard){this.discardParts(item,guard);return;}
    if(fresh.desired==='paused'&&fresh.stopReason!=='cycle-limit')return;
    const previous=this.db.prepare("SELECT max(sent_at) AS n FROM delivery_part WHERE channel=? AND session=? AND seq=? AND state='sent'").get(row.id,row.session,item.seq).n;
    if(Date.now()<Math.max(part.due_at,previous===null?0:previous+part.gap_ms))return;
    this.db.prepare("UPDATE delivery_part SET state='sending' WHERE channel=? AND session=? AND seq=? AND part=? AND state='pending'").run(row.id,row.session,item.seq,part.part);
    this.db.prepare("UPDATE delivery SET state='sending' WHERE channel=? AND session=? AND seq=?").run(row.id,row.session,item.seq);
    try{
      const text=this.unseal(part.payload);if(digest(text)!==part.hash)throw Object.assign(new Error('BUBBLE_PAYLOAD_CHANGED'),{code:'BUBBLE_PAYLOAD_CHANGED',definitelyRejected:true});
      const result=await adapter.send(row.config,text);if(result?.accepted!==true&&result?.sent!==true)throw new Error('DELIVERY_NOT_CONFIRMED');
      const at=Date.now();this.db.prepare("UPDATE delivery_part SET state='sent',receipt=?,payload=NULL,sent_at=? WHERE channel=? AND session=? AND seq=? AND part=? AND binding_generation=?").run(JSON.stringify(result),at,row.id,row.session,item.seq,part.part,part.binding_generation);
      this.db.prepare("UPDATE delivery_part SET due_at=? WHERE channel=? AND session=? AND seq=? AND part>? AND state='pending'").run(at+part.gap_ms,row.id,row.session,item.seq,part.part);
      this.events.append(row.session,crypto.randomUUID(),'delivery-part-sent',{origin:row.id,messageSeq:item.seq,part:part.part,status:'success'});
    }catch(error){
      this.recordError(error,{operation:'delivery-send-part',channel:row.id});
      const delivery=error.definitelyRejected?'rejected':'unknown';this.db.prepare('UPDATE delivery_part SET state=?,receipt=?,payload=NULL WHERE channel=? AND session=? AND seq=? AND part=? AND binding_generation=?').run(delivery,JSON.stringify({code:error.code??'DELIVERY_UNKNOWN'}),row.id,row.session,item.seq,part.part,part.binding_generation);
      this.events.append(row.session,crypto.randomUUID(),'delivery-part-'+delivery,{origin:row.id,messageSeq:item.seq,part:part.part,status:delivery==='rejected'?'failed':'unknown',code:error.code??'DELIVERY_UNKNOWN'});
    }
    this.summarizeParts(item);fresh=await this.runtime.state();const after=this.partGuard(row,item,part,fresh);if(after)this.discardParts(item,after);
    const final=this.db.prepare('SELECT state FROM delivery WHERE channel=? AND session=? AND seq=?').get(row.id,row.session,item.seq);if(final?.state==='sent')this.events.append(row.session,crypto.randomUUID(),'delivery-sent',{origin:row.id,messageSeq:item.seq,status:'success',segmented:true});
  }
  async save(input){
    if(!idOk(input.id)||!(['telegram','dsh-im'].includes(input.kind)||this.adapters.has(input.kind))||!input.config||typeof input.config!=='object')throw new Error('INVALID_CHANNEL');
    const config=structuredClone(input.config);
    if(input.kind==='telegram'&&(!/^\d+:[a-zA-Z0-9_-]+$/.test(config.token??'')||!/^\d{1,20}$/.test(config.ownerId??'')))throw new Error('INVALID_CHANNEL');
    if(input.kind==='dsh-im'&&(!idOk(config.botId)||typeof config.targetId!=='string'||!config.targetId.trim()||config.targetId.length>128))throw new Error('INVALID_CHANNEL');
    if(!['telegram','dsh-im'].includes(input.kind)){const adapter=this.adapters.get(input.kind);if(typeof adapter.validate!=='function')throw new Error('CHANNEL_VALIDATION_REQUIRED');await adapter.validate(config);}
    const state=await this.runtime.state();const last=state.messages.at(-1)?.seq??0;
    config.bindingGeneration=Number(this.preference('binding-generation')||0)+1;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const item of this.db.prepare("SELECT DISTINCT channel,session,seq FROM delivery_part WHERE state='pending'").all())this.discardParts(item,'CHANNEL_REPLACED');
      this.db.prepare("UPDATE delivery_part SET payload=NULL,state=CASE WHEN state='sending' THEN 'unknown' ELSE state END").run();
      this.db.prepare("UPDATE delivery SET payload=NULL,state=CASE WHEN state='pending' THEN 'discarded' WHEN state='sending' THEN 'unknown' ELSE state END WHERE channel IN (SELECT id FROM channel)").run();
      this.db.prepare('DELETE FROM channel').run();
      this.db.prepare('DELETE FROM inbound').run();
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='im_pair'").get())this.db.prepare('DELETE FROM im_pair').run();
      this.preference('binding-generation',config.bindingGeneration);
      this.db.prepare('INSERT INTO channel VALUES(?,?,?,0,?,?,NULL)').run(input.id,input.kind,this.seal(JSON.stringify(config)),state.sessionId,last);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.events.append(state.sessionId,crypto.randomUUID(),'channel-replaced',{channel:input.id,origin:input.id});return this.status();
  }
  async enable(id,enabled){
    const row=this.channel(id);if(!row||typeof enabled!=='boolean')throw new Error('INVALID_CHANNEL');
    if(enabled){const adapter=this.adapters.get(row.kind);if(!adapter)throw new Error('CHANNEL_ADAPTER_UNAVAILABLE');const verified=await adapter.verify(row.config);if(!verified?.privateOwner)throw new Error('PRIVATE_OWNER_REQUIRED');if(this.channel(id)?.config.bindingGeneration!==row.config.bindingGeneration)throw new Error('CHANNEL_REPLACED');}
    this.db.prepare('UPDATE channel SET enabled=?,config=?,error=NULL WHERE id=?').run(enabled?1:0,this.seal(JSON.stringify(row.config)),id);return this.status();
  }
  status(){const wakeBlock=this.wakeBlock();return {sessionMode:'single',replyEnabled:this.preference('reply-enabled'),wakeBlocked:wakeBlock.blocked,wakeBlock,lastError:this.lastError??(this.preference('last-remote-error')||null),adapters:[...this.adapters.keys()],channels:this.db.prepare('SELECT id,kind,enabled,error FROM channel').all(),deliveries:this.db.prepare('SELECT channel,state,count(*) AS count FROM delivery GROUP BY channel,state').all(),deliveryParts:this.db.prepare('SELECT channel,state,count(*) AS count FROM delivery_part GROUP BY channel,state').all(),deliveryUnit:'canonical-message',externalRecall:'not_supported'};}
  async receive(channelId,envelope){
    const work=async()=>{
      const row=this.channel(channelId);if(!row?.enabled)throw new Error('CHANNEL_DISABLED');
      if(row.kind==='telegram'){if(String(envelope.senderId)!==row.config.ownerId||String(envelope.chatId)!==row.config.ownerId||envelope.privateChat!==true)throw new Error('PRIVATE_OWNER_REQUIRED');}
      else{const adapter=this.adapters.get(row.kind);if(typeof adapter?.authorizeInbound!=='function'||await adapter.authorizeInbound(row.config,envelope)!==true)throw new Error('PRIVATE_OWNER_REQUIRED');}
      if(!this.current(row))throw new Error('CHANNEL_REPLACED');
      const attachments=envelope.attachments??[];
      if(!Array.isArray(attachments)||attachments.length>4||attachments.some(row=>!row||Object.keys(row).length!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.id??''))||new Set(attachments.map(row=>row.id)).size!==attachments.length)throw new Error('INVALID_REMOTE_MESSAGE');
      if(!idOk(String(envelope.messageId))||typeof envelope.text!=='string'||!envelope.text.trim()&&!attachments.length||envelope.text.length>1024||attachments.length&&envelope.text.trimStart().startsWith('/'))throw new Error('INVALID_REMOTE_MESSAGE');
      const text=envelope.text.trim(),hash=digest(attachments.length?JSON.stringify({text,attachments}):text),message=String(envelope.messageId);
      const prior=this.db.prepare('SELECT * FROM inbound WHERE channel=? AND message=?').get(channelId,message);
      if(prior&&prior.hash!==hash)throw new Error('REMOTE_MESSAGE_ID_CONFLICT');if(prior?.status==='committed')return {duplicate:true};
      const requestId=prior?.request_id??'im-'+digest(channelId+':'+message).slice(0,40);
      const commitCommand=result=>{this.db.prepare("INSERT INTO inbound(channel,message,hash,request_id,status,kind) VALUES(?,?,?,?,'committed','command') ON CONFLICT(channel,message) DO UPDATE SET status='committed',kind='command'").run(channelId,message,hash,requestId);return result;};
      if(['/new','/session','/clear','/delete','/forget'].some(command=>text===command||text.startsWith(command+' ')))return commitCommand({refused:'SINGLE_SESSION_COMMAND_DISABLED'});
      if(text==='/pause'){await this.controlRuntime({op:'pause'});return commitCommand({command:'paused'});}
      if(text==='/resume')return commitCommand(await this.resumeRuntime());
      const state=await this.runtime.state();if(state.retiring)throw new Error('SESSION_RETIRING');
      if(!this.current(row))throw new Error('CHANNEL_REPLACED');
      if(text==='/status')return commitCommand({command:'status',sessionId:state.sessionId,desired:state.desired});
      if(!prior)this.db.prepare("INSERT INTO inbound(channel,message,hash,request_id,status,kind) VALUES(?,?,?,?,'pending','message')").run(channelId,message,hash,requestId);
      await this.runtime.control({op:'message',requestId,text,...(attachments.length?{attachments}:{}),sessionId:state.sessionId,target:envelope.target==='next-step'?'next-step':'next-turn',origin:channelId});
      this.db.prepare("UPDATE inbound SET status='committed' WHERE channel=? AND message=?").run(channelId,message);
      this.events.append(state.sessionId,crypto.randomUUID(),'message-inbound',{origin:channelId,requestId});
      this.preference('remote-wake',true);
      return {sessionId:state.sessionId,requestId};
    };
    this.receiving=this.receiving.catch(()=>{}).then(work);return this.receiving;
  }
  async tick(){
    if(this.busy||this.closed||this.runtime.closed)return;this.busy=true;
    try{
      const state=await this.runtime.state();if(state.retiring){this.db.prepare('UPDATE delivery_part SET payload=NULL').run();this.db.prepare('UPDATE delivery SET payload=NULL').run();return;}this.db.prepare('DELETE FROM human_event WHERE agent<>?').run(state.sessionId);this.db.prepare('DELETE FROM delivery_confirmation WHERE session<>?').run(state.sessionId);const retention=state.management?.data;if(retention?.logRetentionEnabled&&Date.now()-(this.lastPrune??0)>3600000){this.events.prune(state.sessionId,retention.logRetentionDays);this.lastPrune=Date.now();}
      for(const item of this.db.prepare("SELECT DISTINCT channel,session,seq FROM delivery_part WHERE session<>? AND state='pending'").all(state.sessionId))this.discardParts(item,'SESSION_CHANGED');
      this.db.prepare('UPDATE delivery_part SET payload=NULL WHERE session<>?').run(state.sessionId);
      this.db.prepare("UPDATE delivery SET payload=NULL,state='discarded' WHERE session<>? AND payload IS NOT NULL").run(state.sessionId);
      for(const base of this.db.prepare('SELECT id FROM channel WHERE enabled=1').all()){
        const row=this.channel(base.id),adapter=this.adapters.get(row.kind);if(!adapter)continue;
        try{
          if(row.session!==state.sessionId){row.session=state.sessionId;row.cursor=state.messages.at(-1)?.seq??0;this.db.prepare('UPDATE channel SET session=?,cursor=? WHERE id=?').run(row.session,row.cursor,row.id);}
          if(adapter.poll){const polled=await adapter.poll(row.config);if(!this.current(row))continue;for(const message of polled.messages??[]){if(!this.current(row))break;if(message.senderId!==row.config.ownerId)continue;const result=await this.receive(row.id,message);if(!this.current(row))break;if(result.refused||result.command)await adapter.send(row.config,result.refused?'本 Agent 只有一个会话，请在 Web 管理页面操作。':result.command==='status'?'状态：'+result.desired+'；唯一会话 '+result.sessionId:'已更新回复状态。');}if(polled.offset!==undefined&&this.current(row)){row.config.offset=polled.offset;this.db.prepare('UPDATE channel SET config=? WHERE id=?').run(this.seal(JSON.stringify(row.config)),row.id);}}
          const feed=await this.runtime.events(row.cursor);if(feed.sessionId!==row.session||!this.current(row))continue;
          for(const event of feed.events){
            if(['user','assistant'].includes(event.kind)&&event.origin!==row.id)this.queueDelivery(row,event,state);
            else this.db.prepare('UPDATE channel SET cursor=? WHERE id=?').run(event.seq,row.id);
          }
          for(const item of this.db.prepare("SELECT * FROM delivery WHERE channel=? AND session=? AND state='pending' ORDER BY seq LIMIT 10").all(row.id,row.session)){
            const part=this.db.prepare("SELECT * FROM delivery_part WHERE channel=? AND session=? AND seq=? AND state='pending' ORDER BY part LIMIT 1").get(row.id,row.session,item.seq);
            if(part){await this.sendPart(row,adapter,item,part);break;}
            const fresh=await this.runtime.state();if(fresh.retiring||fresh.sessionId!==item.session||!this.current(row))break;
            this.db.prepare("UPDATE delivery SET state='sending' WHERE channel=? AND session=? AND seq=?").run(row.id,row.session,item.seq);
            try{const result=await adapter.send(row.config,this.unseal(item.payload));if(result?.accepted!==true&&result?.sent!==true)throw new Error('DELIVERY_NOT_CONFIRMED');this.db.prepare("UPDATE delivery SET state='sent',receipt=?,payload=NULL WHERE channel=? AND session=? AND seq=?").run(JSON.stringify(result),row.id,row.session,item.seq);this.events.append(row.session,crypto.randomUUID(),'delivery-sent',{origin:row.id,messageSeq:item.seq,status:'success'});}
            catch(error){this.recordError(error,{operation:'delivery-send',channel:row.id});const delivery=error.definitelyRejected?'rejected':'unknown';this.db.prepare("UPDATE delivery SET state=?,receipt=? WHERE channel=? AND session=? AND seq=?").run(delivery,JSON.stringify({code:error.code??'DELIVERY_UNKNOWN'}),row.id,row.session,item.seq);this.events.append(row.session,crypto.randomUUID(),'delivery-'+delivery,{origin:row.id,messageSeq:item.seq,status:delivery==='rejected'?'failed':'unknown',code:error.code??'DELIVERY_UNKNOWN'});}
          }
          if(this.current(row))this.db.prepare('UPDATE channel SET error=NULL WHERE id=?').run(row.id);
        }catch(error){const failure=this.recordError(error,{operation:'channel-tick',channel:row.id});if(this.current(row))this.db.prepare('UPDATE channel SET error=? WHERE id=?').run(failure.code,row.id);}
      }
      const fresh=await this.runtime.state();
      if(fresh.inbox===0)this.preference('remote-wake',false);
      if(!this.closed&&!this.wakeBlock().blocked&&this.preference('remote-wake')&&this.preference('reply-enabled')&&!fresh.agentBusy&&fresh.desired==='paused'&&fresh.inbox>0&&fresh.canThink&&!['error','budget'].includes(fresh.stopReason))await this.controlRuntime({op:'once',sessionId:fresh.sessionId,expectedEpoch:fresh.cancelEpoch},{automatic:true});
    }finally{this.busy=false;}
  }
  async close(){this.closed=true;await this.receiving.catch(error=>this.recordError(error,{operation:'ingress-close'}));await this.controls.catch(error=>this.recordError(error,{operation:'control-close'}));while(this.busy)await new Promise(r=>setTimeout(r,50));this.db.close();}
}
