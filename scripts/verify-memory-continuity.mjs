import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DomainMemory} from '../plugins/become-human/domain.mjs';
import {MemoryLifecycle} from '../plugins/become-human/memory-lifecycle.mjs';
import {RollingDialogueSummary} from '../plugins/become-human/dialogue-summary.mjs';
import {recentDialogue} from '../plugins/become-human/dialogue-history.mjs';
const {searchConversationMemory,assertConversationMemoryCurrent,registerConversationRecall}=await import(process.env.BH_TEST_RECALL_MODULE??'../plugins/become-human/conversation-recall.mjs');

// Real SQLite and native event-shaped fixtures; no production paths or model calls.
const root=await fs.mkdtemp(path.join(process.env.BH_TEST_TMP??os.tmpdir(),'human-memory-continuity-')),cases=[];
async function fixture(){
 const dir=path.join(root,randomUUID());await fs.mkdir(dir);const id=randomUUID(),events=[];let db,domain,lifecycle,summary,agent,journal,time=Date.parse('2026-01-01T00:00:00Z');
 function open(){
  db=new DatabaseSync(path.join(dir,'memory.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS test_values(agent TEXT,key TEXT,value TEXT,PRIMARY KEY(agent,key));CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,agent TEXT,kind TEXT,text TEXT,created INTEGER,event_key TEXT);');
  journal={db,assertAdmitted(key){assert.equal(key,id);},value(key,name,fallback){const row=db.prepare('SELECT value FROM test_values WHERE agent=? AND key=?').get(key,name);return row?JSON.parse(row.value):fallback;},put(key,name,value){db.prepare('INSERT INTO test_values VALUES(?,?,?) ON CONFLICT(agent,key) DO UPDATE SET value=excluded.value').run(key,name,JSON.stringify(value));},transaction(fn){db.exec('BEGIN');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},audit(){}};
  domain=new DomainMemory(journal,{clock:()=>time});lifecycle=new MemoryLifecycle(journal,domain,{clock:()=>time});domain.lifecycle=lifecycle;
  agent={id,session:{snapshotEvents:()=>events},factory:{journal,domain,management:{execution:()=>({context:{historyLimit:8}})}}};summary=new RollingDialogueSummary(journal,domain,{clock:()=>time});agent.factory.conversationSummary=summary;
 }
 open();
 function owner(text,{observe=false}={}){const message={id:randomUUID(),role:'user',source:{kind:'human'},content:[{type:'text',text}]};time++;domain.source(id,{id:message.id,body:text,occurred:time});db.prepare('INSERT INTO outbox(agent,kind,text,created,event_key) VALUES(?,?,?,?,?)').run(id,'user',text,time,'user:'+message.id);events.push({type:'user/message',time,seq:events.length,data:message});if(observe)domain.observe(id,message,time);return message;}
 function turn(text='合成历史问题',answer='已记录这次交流。'){const input=owner(text),message={id:randomUUID(),role:'assistant',content:[{type:'text',text:answer}]};time++;db.prepare('INSERT INTO outbox(agent,kind,text,created,event_key) VALUES(?,?,?,?,?)').run(id,'assistant',answer,time,'assistant:'+message.id);journal.put(id,'dialogue-origin:'+message.id,{inputIds:[input.id],lane:'foreground'});events.push({type:'assistant/message',time,seq:events.length,data:{message}});return {input,answer:message};}
 function seed(){const turns=Array.from({length:6},(_,i)=>turn('合成约定 '+i,'保留这次约定。')),current=owner('继续刚才的话题');const job=summary.prepare(agent,{admittedIds:[current.id],recentTurnLimit:1});assert(job);summary.commit(agent,job,{topics:[{text:'早期约定保存在当前对话中。',sourceIds:[turns[0].input.id]}],decisions:[],openQuestions:[],corrections:[]});return {turns,current,job};}
 function grow(){journal.transaction(()=>{for(let i=0;i<270;i++)turn('后续独立话题 '+i);});return owner('想回顾最早的约定');}
 return {id,dir,events,owner,turn,seed,grow,get db(){return db;},get agent(){return agent;},get domain(){return domain;},get lifecycle(){return lifecycle;},get summary(){return summary;},get journal(){return journal;},tick(ms){time+=ms;},reopen(){db.close();open();},close(){db.close();}};
}
async function test(name,fn){let f;try{f=await fixture();await fn(f);cases.push({name,passed:true});}catch(error){cases.push({name,passed:false,error:error.stack});}finally{f?.close();}console.log(JSON.stringify(cases.at(-1)));}

await test('A valid summary survives when its original replies leave the 256-reply raw scan',f=>{
 const {turns}=f.seed(),current=f.grow(),raw=recentDialogue(f.agent,{lane:'foreground',admittedIds:[current.id],turnLimit:256});assert(!raw.some(row=>row.id===turns[0].input.id));assert(raw.coverage.olderNativeRepliesOutsideScan>0);
 const context=f.summary.context(f.agent,{admittedIds:[current.id]});assert(context,'retained summary must not expire just because raw history is bounded');assert(context.sources.some(row=>row.id===turns[0].input.id));assert.equal(context.ownerFactsWritten,false);assert.equal(context.semanticValidation,'unverified-model-summary');
});
await test('Cold reopening retains the older summary and its original provenance',f=>{
 const {turns}=f.seed(),current=f.grow();f.reopen();const context=f.summary.context(f.agent,{admittedIds:[current.id]});assert(context);assert(context.sources.some(row=>row.id===turns[0].input.id));assert.equal(f.summary.snapshot(f.agent,{admittedIds:[current.id]}).invalidatedChunks,0);
});
await test('Withdrawing an older owner dependency still invalidates its summary',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));f.db.prepare("UPDATE source_record SET status='forgotten' WHERE agent=? AND id=?").run(f.id,turns[0].input.id);assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('Changing old reply attribution cannot retain a summary under different inputs',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));f.journal.put(f.id,'dialogue-origin:'+turns[0].answer.id,{inputIds:[turns[1].input.id],lane:'foreground'});assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('An older reply removed from the native session cannot be resurrected from outbox alone',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));f.events.splice(f.events.findIndex(e=>e.type==='assistant/message'&&e.data.message.id===turns[0].answer.id),1);assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('An old work observation revoked after summarization is excluded',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));f.journal.put(f.id,'work-observation-message:'+turns[0].answer.id,[{id:'observation',version:1}]);f.agent.factory.workObservation={get:()=>({valid:false,version:2})};assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('Editing an older source invalidates the original summary even with a newly consistent hash',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));const body='修订后的合成约定';f.db.prepare('UPDATE source_record SET body=?,hash=? WHERE agent=? AND id=?').run(body,createHash('sha256').update(JSON.stringify(body)).digest('hex'),f.id,turns[0].input.id);assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('Changed older assistant native text cannot stand in for its published reply',f=>{
 const {turns}=f.seed(),current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));turns[0].answer.content=[{type:'text',text:'这不是当时发布的回复。'}];assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('Later messages are neither claimed by retained summaries nor added to their source references',f=>{
 const {job}=f.seed(),current=f.grow(),context=f.summary.context(f.agent,{admittedIds:[current.id]}),pending=f.summary.prepare(f.agent,{admittedIds:[current.id]});assert(context);assert(pending);assert(context.sources.every(row=>job.sourceIds.includes(row.id)));assert(context.sources.every(row=>row.id!==current.id));assert(pending.sourceIds.every(id=>!job.sourceIds.includes(id)));assert(context.backlogTurns>0);assert.equal(context.sourceTurnCount,job.coveredTurnIds.length);
 const raw=recentDialogue(f.agent,{lane:'foreground',admittedIds:[current.id]});assert(raw.coverage.selectedTurnCount<=8);assert(!raw.some(row=>job.sourceIds.includes(row.id)));
});
await test('Memory context reset still invalidates retained old chunks',f=>{
 f.seed();const current=f.grow();assert(f.summary.context(f.agent,{admittedIds:[current.id]}));f.journal.put(f.id,'memoryContextBarrierAt',Date.parse('2027-01-01T00:00:00Z'));assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);
});
await test('Normal and explicitly developmental summary scopes remain separated after a long history',f=>{
 f.seed();f.grow();const current=f.owner('【开发测试】这是隔离检查，不代表真实偏好');assert.equal(f.summary.context(f.agent,{admittedIds:[current.id]}),null);assert.equal(f.domain.recall(f.id,{query:'真实偏好'}).length,0);
});
await test('Targeted provenance lookup is bounded and cannot admit unrelated or unfinished turns',f=>{
 const first=f.turn(),second=f.turn();f.owner('尚未回答的输入');const rows=recentDialogue(f.agent,{lane:'foreground',retainedReplyIds:[first.answer.id]});assert.deepEqual(rows.map(row=>row.id),[first.input.id,first.answer.id]);assert(!rows.some(row=>row.id===second.answer.id));assert.deepEqual(recentDialogue(f.agent,{retainedReplyIds:[]}),[]);assert.throws(()=>recentDialogue(f.agent,{retainedReplyIds:Array.from({length:289},()=>randomUUID())}),/INVALID_DIALOGUE_HISTORY_SELECTION/);
});
await test('Retained summary capacity still evicts old chunks instead of retaining history without limit',f=>{
 const original=f.seed(),current=f.grow();for(let i=0;i<14;i++){const job=f.summary.prepare(f.agent,{admittedIds:[current.id],recentTurnLimit:1});if(!job)break;f.summary.commit(f.agent,job,{topics:[{text:'本批后续话题摘要。',sourceIds:[job.sourceIds[0]]}],decisions:[],openQuestions:[],corrections:[]});}
 for(let i=0;i<8;i++)f.turn('容量边界后的新增话题 '+i);const next=f.owner('继续回顾'),job=f.summary.prepare(f.agent,{admittedIds:[next.id],recentTurnLimit:1});assert(job);f.summary.commit(f.agent,job,{topics:[{text:'新增批次摘要。',sourceIds:[job.sourceIds[0]]}],decisions:[],openQuestions:[],corrections:[]});
 const state=f.summary.snapshot(f.agent,{admittedIds:[next.id],recentTurnLimit:1});assert.equal(state.chunkCount,12);assert(state.evictedChunks>=1);const context=f.summary.context(f.agent,{admittedIds:[next.id]});assert(context);assert(!context.sources.some(row=>original.job.sourceIds.includes(row.id)));assert(state.omittedOlderTurns>=original.job.coveredTurnIds.length);
});
await test('Unrelated cold memories stay out; a matched older episode survives more than 512 recent episodes',f=>{
 const old=f.owner('偏远高地的星图约定',{observe:true});f.tick(40*86400000);for(let i=0;i<520;i++)f.owner('合成普通记录 '+i,{observe:true});f.lifecycle.maintain(f.id);
 const empty=f.domain.recall(f.id,{limit:100});assert(!empty.some(r=>r.refs.includes(old.id)));const match=f.domain.recall(f.id,{query:'星图约定',limit:8});assert(match.some(r=>r.refs.includes(old.id)));assert.equal(match.find(r=>r.refs.includes(old.id)).lifecycle.tier,'cold');
 f.reopen();assert(f.domain.recall(f.id,{query:'星图约定',limit:8}).some(r=>r.refs.includes(old.id)));f.db.prepare("UPDATE source_record SET status='forgotten' WHERE agent=? AND id=?").run(f.id,old.id);assert(!f.domain.recall(f.id,{query:'星图约定',limit:8}).some(r=>r.refs.includes(old.id)));
});
await test('Multiple preferences coexist and a correction changes only its own slot across restart',f=>{
 f.owner('我喜欢游泳和绘画',{observe:true});f.owner('我还喜欢摄影',{observe:true});f.owner('我不再喜欢游泳了',{observe:true});f.reopen();const facts=f.domain.recall(f.id,{limit:100,excludeTypes:['episode']}).filter(r=>r.payload.predicate==='preference');assert.equal(facts.length,3);assert(facts.some(r=>r.payload.value==='游泳'&&r.payload.polarity==='dislike'));assert(facts.some(r=>r.payload.value==='绘画'&&!r.payload.polarity));assert(facts.some(r=>r.payload.value==='摄影'&&!r.payload.polarity));
});
await test('Model-supplied query variants retrieve original wording without creating facts or aliases',f=>{
 const old=f.owner('我周末经常去慢跑。');f.owner('接着聊别的');const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(searchConversationMemory(f.agent,{queries:['锻炼习惯']}).matches.length,0);
 const result=searchConversationMemory(f.agent,{queries:['锻炼习惯','慢跑']});assert.equal(result.matches[0].sourceId,old.id);assert.equal(result.matches[0].speaker,'user');assert.equal(result.matches[0].text,'我周末经常去慢跑。');assert.equal(result.automaticMemoryWrite,false);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assertConversationMemoryCurrent(f.agent,result);
});
await test('Original speech is searchable beyond the recent dialogue and cold-memory windows',f=>{
 const old=f.owner('周末喜欢做木工模型。');f.tick(40*86400000);f.journal.transaction(()=>{for(let i=0;i<600;i++)f.turn('后面的无关话题 '+i);});f.owner('想聊业余爱好');f.reopen();const result=searchConversationMemory(f.agent,{queries:['木工']});assert.equal(result.matches[0].sourceId,old.id);
});
await test('A large development transcript cannot crowd normal original speech out of recall',f=>{
 const old=f.owner('喜欢安静的山谷徒步。');for(let i=0;i<120;i++)f.owner('【开发测试】山谷徒步合成材料 '+i);f.owner('说说上次的休闲安排');const result=searchConversationMemory(f.agent,{queries:['山谷徒步']});assert.deepEqual(result.matches.map(r=>r.sourceId),[old.id]);
});
await test('Development recall sees only its current contiguous segment and no owner facts',f=>{
 f.owner('【开发测试】虚构沙漠夜行');f.owner('现实里的沙漠话题');const old=f.owner('【开发测试】虚构沙漠营地');f.owner('【开发测试】继续');const result=searchConversationMemory(f.agent,{queries:['沙漠']});assert.deepEqual(result.matches.map(r=>r.sourceId),[old.id]);assert(result.matches[0].developmentOnly);
});
await test('Recall excludes the current admitted turn and never returns an assistant as a user',f=>{
 const old=f.turn('我喜欢雨天的书店','我喜欢沙漠旅行');f.events.push({type:'turn/start',data:{turn:1}});const current=f.owner('我之前喜欢沙漠旅行吗');const result=searchConversationMemory(f.agent,{queries:['雨天','沙漠']});assert.deepEqual(result.matches.map(r=>r.sourceId),[old.input.id]);assert(!result.matches.some(r=>r.sourceId===current.id));
});
await test('Native removal, source withdrawal and barriers prevent recall and invalidate old receipts',f=>{
 const old=f.owner('记录樱桃花期'),result=searchConversationMemory(f.agent,{queries:['樱桃']});assert(result.matches.length);f.db.prepare("UPDATE source_record SET status='forgotten' WHERE agent=? AND id=?").run(f.id,old.id);assert.equal(searchConversationMemory(f.agent,{queries:['樱桃']}).matches.length,0);assert.throws(()=>assertConversationMemoryCurrent(f.agent,result),/STALE_CONVERSATION_MEMORY/);
 const another=f.owner('记录海棠花期'),second=searchConversationMemory(f.agent,{queries:['海棠']});f.events.splice(f.events.findIndex(e=>e.data?.id===another.id),1);assert.throws(()=>assertConversationMemoryCurrent(f.agent,second),/STALE_CONVERSATION_MEMORY/);
 f.owner('记录木棉花期');const third=searchConversationMemory(f.agent,{queries:['木棉']});f.journal.put(f.id,'memoryContextBarrierAt',Date.parse('2030-01-01'));assert.equal(searchConversationMemory(f.agent,{queries:['木棉']}).matches.length,0);assert.throws(()=>assertConversationMemoryCurrent(f.agent,third),/STALE_CONVERSATION_MEMORY/);
});
await test('Edits to the native text or cached result cannot masquerade as old original speech',f=>{
 const old=f.owner('记录银杏花期'),result=searchConversationMemory(f.agent,{queries:['银杏']});const forged=structuredClone(result);forged.matches[0].text='伪造的内容';assert.throws(()=>assertConversationMemoryCurrent(f.agent,forged),/STALE_CONVERSATION_MEMORY/);old.content[0].text='已经改成了别的事';assert.throws(()=>assertConversationMemoryCurrent(f.agent,result),/STALE_CONVERSATION_MEMORY/);
});
await test('Recall reports incomplete excerpts, bounded results and historical ordering',f=>{
 const first=f.owner('观察星云'+('远'.repeat(1800))+'仍待确认');for(let i=0;i<10;i++)f.owner('观察星云记录 '+i);const result=searchConversationMemory(f.agent,{queries:['星云'],limit:8});assert.equal(result.matches.length,8);assert(result.matches.every((row,i,rows)=>!i||row.order>rows[i-1].order));const long=searchConversationMemory(f.agent,{queries:['仍待确认']});assert.equal(long.matches[0].sourceId,first.id);assert(long.matches[0].excerpted);assert(long.matches[0].text.endsWith('仍待确认'));assert.equal(result.coverage.semanticCompleteness,false);
});
await test('No matches or invalid queries do not create knowledge or claim exhaustive absence',f=>{
 const result=searchConversationMemory(f.agent,{queries:['不存在的城堡']});assert.equal(result.matches.length,0);assert.equal(result.coverage.semanticCompleteness,false);for(const input of [{queries:[]},{queries:['   ']},{queries:Array(5).fill('词')},{queries:['词'],agent:'other'}])assert.throws(()=>searchConversationMemory(f.agent,input),/INVALID_TOOL_INPUT/);
});
await test('Alternative queries do not combine unrelated weak words into a claimed match',f=>{
 f.owner('林澄会沿河慢跑。');f.owner('另一个人喜欢蓝色。');f.owner('请继续');const result=searchConversationMemory(f.agent,{queries:['林澄 帆船 颜色','帆船 最喜欢 什么颜色','林澄 帆船']});assert.equal(result.matches.length,0);
 const found=searchConversationMemory(f.agent,{queries:['林澄 沿河慢跑','有氧运动']});assert.equal(found.matches.length,1);assert(found.matches[0].text.includes('沿河慢跑'));
});
await test('Capability registration preserves read-only single-agent execution and rejects autonomous use',async f=>{
 let definition;registerConversationRecall({register(_name,d){definition=d;return ()=>{};}},id=>id===f.id?f.agent:null);assert.equal(definition.effect,'read');assert.equal(definition.autonomous,false);await assert.rejects(definition.execute({queries:['山谷']},new AbortController().signal,{agent:f.id,origin:'autonomous'}),/OWNER_MEMORY_RECALL_ONLY/);await assert.rejects(definition.execute({queries:['山谷']},new AbortController().signal,{agent:'other',origin:'owner'}),/MEMORY_RECALL_UNAVAILABLE/);
});
await test('A shared person and generic noun cannot substitute for the requested topic',f=>{
 const person='人物'+randomUUID().slice(0,6);f.owner(person+'的鹦鹉叫什么名字？');f.owner(person+'周日有约。');
 const result=searchConversationMemory(f.agent,{queries:[person+' 仓鼠 名字',person+' 养的仓鼠','仓鼠叫什么']});assert.equal(result.matches.length,0);
});
await test('An unspaced query remains a literal phrase instead of matching question fragments',f=>{
 f.owner('鹦鹉叫什么名字？');assert.equal(searchConversationMemory(f.agent,{queries:['仓鼠叫什么']}).matches.length,0);
 const original=f.owner('仓鼠叫松果。');assert.equal(searchConversationMemory(f.agent,{queries:['仓鼠叫什么','仓鼠叫']}).matches[0].sourceId,original.id);
});
await test('Keyword order is flexible while alternatives preserve the model-selected subject',f=>{
 const person='人物'+randomUUID().slice(0,6),old=f.owner('在北门等'+person+'，周日下午四点见。');f.owner(person+'在东门等，周五见。');
 const result=searchConversationMemory(f.agent,{queries:[person+' 北门 周日',person+' 周日 北门','不存在的表达']});assert.deepEqual(result.matches.map(row=>row.sourceId),[old.id]);
});
await test('A lexical match to an obsolete decision cannot displace the newest correction',f=>{
 const first=Array.from({length:6},()=>f.turn('旧安排橙色展厅周五晚上见面','先这样安排'));let current=f.owner('继续');let job=f.summary.prepare(f.agent,{admittedIds:[current.id],recentTurnLimit:1});f.summary.commit(f.agent,job,{topics:[],decisions:first.slice(0,3).map(t=>({text:'旧安排橙色展厅周五晚上见面。'+('旧信息'.repeat(30)),sourceIds:[t.input.id]})),openQuestions:[],corrections:[]});
 const changed=f.turn('更正：改到周日下午，地点暂不确定。','按新安排。');for(let i=0;i<5;i++)f.turn('后来无关的话题 '+i);current=f.owner('回顾旧安排橙色展厅周五晚上见面');job=f.summary.prepare(f.agent,{admittedIds:[current.id],recentTurnLimit:1});assert(job.sourceIds.includes(changed.input.id));f.summary.commit(f.agent,job,{topics:[],decisions:[],openQuestions:[],corrections:[{text:'改到周日下午，地点暂不确定。',sourceIds:[changed.input.id]}]});
 let inspected=0;for(const maxBytes of [1600,1800,2200,2600,3000]){const result=f.summary.context(f.agent,{admittedIds:[current.id],query:'旧安排橙色展厅周五晚上见面',maxBytes});if(!result)continue;inspected++;assert(result.sections.corrections.some(item=>item.sourceIds.includes(changed.input.id)),'new correction missing at '+maxBytes);}assert(inspected);
});
await test('Adjacent correction without repeated subject is returned as context, never a keyword hit',f=>{
 const original=f.owner('陶川约在周二南门见面。'),correction=f.owner('改成周四，其他不变。');f.owner('换个话题');const r=searchConversationMemory(f.agent,{queries:['陶川 南门']});assert.equal(r.matches.length,1);assert.equal(r.matches[0].sourceId,original.id);assert.equal(r.context[0].sourceId,correction.id);assert.equal(r.context[0].relation,'following-user-speech');assert.equal(r.context[0].adjacentTo,original.id);assert.equal(r.context[0].speaker,'user');assertConversationMemoryCurrent(f.agent,r);
});
await test('Withdrawing a neighbouring correction invalidates the whole receipt before use',f=>{f.owner('合成绘画课程在周六。');const changed=f.owner('更正，是周日。');f.owner('别的话题');const r=searchConversationMemory(f.agent,{queries:['绘画课程']});assert(r.context.some(x=>x.sourceId===changed.id));f.db.prepare("UPDATE source_record SET status='forgotten' WHERE agent=? AND id=?").run(f.id,changed.id);assert.throws(()=>assertConversationMemoryCurrent(f.agent,r),/STALE_CONVERSATION_MEMORY/);assert(!searchConversationMemory(f.agent,{queries:['绘画课程']}).context.some(x=>x.sourceId===changed.id));});
await test('Context cannot relabel speakers or splice in unrelated history',f=>{f.owner('合成车站约定');f.owner('改到上午');f.owner('晚饭话题');const r=searchConversationMemory(f.agent,{queries:['车站']});let bad=structuredClone(r);bad.context[0].speaker='assistant';assert.throws(()=>assertConversationMemoryCurrent(f.agent,bad),/STALE_CONVERSATION_MEMORY/);bad=structuredClone(r);bad.context[0].relation='preceding-user-speech';assert.throws(()=>assertConversationMemoryCurrent(f.agent,bad),/STALE_CONVERSATION_MEMORY/);bad=structuredClone(r);bad.context[0].text='伪造的新安排';assert.throws(()=>assertConversationMemoryCurrent(f.agent,bad),/STALE_CONVERSATION_MEMORY/);});
await test('Current turn and a different development scope never become neighbouring historical evidence',f=>{const first=f.owner('真实花店约定');f.owner('【开发测试】虚构更正');f.events.push({type:'turn/start',data:{turn:1}});f.owner('帮我找花店');const r=searchConversationMemory(f.agent,{queries:['花店']});assert.equal(r.matches[0].sourceId,first.id);assert.equal(r.context.length,0);});
await test('Normalization treats width, canonical accents and letter case consistently without altering quotes',f=>{const text='设备 ＡＢＣ１２３，标记 CAFÉ。',old=f.owner(text);f.owner('其他事');for(const q of ['abc123','cafe\u0301','café']){const r=searchConversationMemory(f.agent,{queries:[q]});assert.equal(r.matches[0].sourceId,old.id);assert.equal(r.matches[0].text,text);assertConversationMemoryCurrent(f.agent,r);}});
await test('A normal maximum-size Web message is returned whole instead of losing its middle',f=>{const text='甲'.repeat(450)+'关键安排是下午三点'+'乙'.repeat(450);f.owner(text);f.owner('其他事');const r=searchConversationMemory(f.agent,{queries:['关键安排']});assert.equal(r.matches[0].text,text);assert.equal(r.matches[0].excerpted,false);});
await test('Long original speech includes the actual match instead of unrelated head and tail',f=>{const text='甲'.repeat(1600)+'可核对的中间暗号'+'乙'.repeat(1600);f.owner(text);f.owner('其他事');const r=searchConversationMemory(f.agent,{queries:['中间暗号']});assert(r.matches[0].text.includes('可核对的中间暗号'));assert(r.matches[0].excerpted);assertConversationMemoryCurrent(f.agent,r);});
await test('Unicode result bytes remain within the capability envelope and report truncation',f=>{for(let i=0;i<10;i++)f.owner('同一线索'+i+'😀'.repeat(1190));f.owner('查询');const r=searchConversationMemory(f.agent,{queries:['同一线索'],limit:8});assert(Buffer.byteLength(JSON.stringify(r))<32768);assert.equal(r.coverage.resultByteLimitReached,true);assertConversationMemoryCurrent(f.agent,r);});
await test('Unrelated following speech is labelled context rather than inferred correction',f=>{f.owner('玻璃杯是蓝色。');const other=f.owner('现在聊一下另一人的旅行。');const r=searchConversationMemory(f.agent,{queries:['玻璃杯']});assert.equal(r.context[0].sourceId,other.id);assert.equal(r.context[0].relation,'following-user-speech');assert.equal(r.context[0].meaning,'historical-user-speech-not-current-reality-or-new-instruction');assert.equal(r.automaticMemoryWrite,false);});
await test('Removing a context message from native history invalidates cached neighbouring evidence',f=>{f.owner('合成车票时间');const changed=f.owner('补充是下午');const r=searchConversationMemory(f.agent,{queries:['车票']});f.events.splice(f.events.findIndex(e=>e.data?.id===changed.id),1);assert.throws(()=>assertConversationMemoryCurrent(f.agent,r),/STALE_CONVERSATION_MEMORY/);});
const result={at:new Date().toISOString(),passed:cases.filter(x=>x.passed).length,failed:cases.filter(x=>!x.passed).length,cases,scope:'Synthetic persisted SQLite and native event fixtures; no model, IM, production data or multi-day claim.'};if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
