import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {conversationRecords} from '../plugins/become-human/conversation-records.mjs';
import {readableRecord,recordValue} from '../plugins/become-human-web/record-presentation.mjs';
import {taskBoard} from '../plugins/become-human/task-board.mjs';

const db=new DatabaseSync(':memory:'),values=new Map(),cases=[];
db.exec(`CREATE TABLE outbox(seq INTEGER PRIMARY KEY,agent TEXT,kind TEXT,text TEXT,created INTEGER,event_key TEXT);
CREATE TABLE user_request(agent TEXT,message_id TEXT,request_id TEXT);
CREATE TABLE attempt(id TEXT PRIMARY KEY,agent TEXT,request TEXT);
CREATE TABLE response_stage(id TEXT,agent TEXT,state TEXT,payload TEXT);
CREATE TABLE metadata(agent TEXT,key TEXT,value TEXT);
CREATE TABLE human_event(agent TEXT,task_id TEXT,kind TEXT,data TEXT);`);
const factory={journal:{db,assertAdmitted:id=>{if(id!=='human')throw Error('RETIRED_OR_OTHER_SESSION');},value:(id,key,fallback)=>values.get(id+':'+key)??fallback},media:{messageDescriptors:(id,key)=>key==='u1'?[{id:'photo',name:'image.png'}]:[]}};
const insert=db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)');
for(let i=1;i<=121;i++)insert.run(i,'human',i%3===0?'assistant':i%3===1?'user':'wait','message '+i,1700000000000+i,(i%3===1?'user:u':'assistant:a')+i);
insert.run(122,'other','user','private-other',1700000001000,'user:other');
const read=input=>conversationRecords(factory,'human',input);
function test(name,body){body();cases.push(name);}
try{
 test('all durable messages can be paged beyond the previous 30-message window',()=>{let page=read({limit:17}),all=[...page.items];while(page.hasMore){page=read({limit:17,before:page.nextBefore,ceiling:page.ceiling});all.push(...page.items);}assert.equal(all.length,121);assert.equal(new Set(all.map(m=>m.seq)).size,121);assert.equal(Math.min(...all.map(m=>m.seq)),1);assert.ok(all.every(m=>m.text!=='private-other'));});
 test('each page is chronological, cursor stable while new messages arrive',()=>{const first=read({limit:40});insert.run(123,'human','assistant','new arrival',1700000002000,'assistant:new');const next=read({limit:40,before:first.nextBefore,ceiling:first.ceiling});assert.deepEqual(first.items.map(m=>m.seq),Array.from({length:40},(_,i)=>82+i));assert.deepEqual(next.items.map(m=>m.seq),Array.from({length:40},(_,i)=>42+i));assert.equal(read({ceiling:first.ceiling,limit:1}).items[0].seq,121);});
 test('literal search and speaker filtering never interpret SQL or wildcard characters',()=>{assert.equal(read({query:"' OR 1=1--"}).items.length,0);assert.equal(read({query:'%'}).items.length,0);assert.ok(read({role:'user',query:'message 1'}).items.every(m=>m.kind==='user'&&m.text.includes('message 1')));assert.ok(read({role:'system'}).items.every(m=>!['user','assistant'].includes(m.kind)));});
 test('owner channel, images and input-batch reply relationships are preserved',()=>{db.prepare('INSERT INTO user_request VALUES(?,?,?)').run('human','u1','req1');values.set('human:origin:req1','weixin:one');values.set('human:dialogue-origin:a3',{inputIds:['u1','u4']});assert.equal(read({query:'message 1',role:'user',limit:100}).items[0].origin,'weixin:one');assert.equal(read({ceiling:1}).items[0].attachments[0].id,'photo');assert.deepEqual(read({query:'message 3',role:'assistant'}).items[0].replyTo,['u1','u4']);});
 test('task transcripts survive committed staging payload erasure using durable origin links',()=>{db.prepare('INSERT INTO attempt VALUES(?,?,?)').run('attempt-1','human',JSON.stringify({taskId:'task-1',admittedIds:['u1','u4']}));db.prepare('INSERT INTO response_stage VALUES(?,?,?,?)').run('attempt-1','human','committed','null');db.prepare('INSERT INTO metadata VALUES(?,?,?)').run('human','dialogue-origin:a3',JSON.stringify({attemptId:'attempt-1',inputIds:['u1','u4']}));assert.deepEqual(read({taskId:'task-1'}).items.map(m=>m.seq),[1,3,4]);assert.deepEqual(read({taskId:'no-link'}).items,[]);});
 test('failed and other-session responses cannot create task transcript associations',()=>{db.prepare('INSERT INTO attempt VALUES(?,?,?)').run('attempt-2','human',JSON.stringify({taskId:'task-2'}));db.prepare('INSERT INTO response_stage VALUES(?,?,?,?)').run('attempt-2','human','ready',JSON.stringify({data:{message:{id:'a6'}}}));db.prepare('INSERT INTO response_stage VALUES(?,?,?,?)').run('attempt-1','other','committed',JSON.stringify({data:{message:{id:'a9'}}}));assert.deepEqual(read({taskId:'task-2'}).items,[]);assert.deepEqual(read({taskId:'task-1'}).items.map(m=>m.seq),[1,3,4]);});
 test('legacy explicit publication events work without origin metadata and never include neighbors',()=>{db.prepare('INSERT INTO human_event VALUES(?,?,?,?)').run('human','legacy-task','response-published',JSON.stringify({messageId:'a6',inputId:'u4'}));db.prepare('INSERT INTO human_event VALUES(?,?,?,?)').run('other','legacy-task','response-published',JSON.stringify({messageId:'a9'}));assert.deepEqual(read({taskId:'legacy-task'}).items.map(m=>m.seq),[4,6]);});
 test('invalid cursors, limits, roles, queries and retired sessions are rejected',()=>{for(const input of [{before:0},{before:-1},{before:1.2},{before:'1'},{ceiling:Infinity},{limit:101},{limit:0},{query:{}},{query:'x'.repeat(161)},{role:'admin'},{taskId:''},{taskId:{}}])assert.throws(()=>read(input),/INVALID_CONVERSATION_QUERY/);assert.throws(()=>conversationRecords(factory,'other',{}),/RETIRED_OR_OTHER_SESSION/);});
 test('empty filtered pages have no unusable continuation cursor',()=>{const result=read({query:'not present'});assert.equal(result.hasMore,false);assert.equal(result.nextBefore,null);assert.equal(result.scope,'durable-published-messages');});
 test('readable diagnostics omit credential fields and private provider reasoning',()=>{const safe=readableRecord({summary:'Visible',reasoning_content:'private',nested:{apiKey:'private',inputTokens:42},url:'https://example.test/?token=secret&v=1'});assert.deepEqual(safe,{summary:'Visible',nested:{inputTokens:42},url:'https://example.test/?token=[已隐藏]&v=1'});assert.equal(recordValue(false),'否');assert.equal(recordValue(null),'未记录');});
 test('task counters match time/source/search while retaining all-history totals',()=>{
  const tasks=new DatabaseSync(':memory:');try{
   tasks.exec("CREATE TABLE autonomy_task(id TEXT,agent TEXT,kind TEXT,status TEXT,checkpoint TEXT,created INTEGER,updated INTEGER)");
   const add=tasks.prepare('INSERT INTO autonomy_task VALUES(?,?,?,?,?,?,?)');
   add.run('old-failed','human','behavior','failed','{}',1,100);add.run('recent-failed','human','behavior','failed','{}',1,300);add.run('recent-done','human','behavior','completed','{}',1,400);
   const board=taskBoard({journal:{db:tasks,assertAdmitted:()=>{}}},'human',{from:200,group:'attention'});
   assert.equal(board.counts.all,3);assert.equal(board.filteredCounts.all,2);assert.equal(board.filteredCounts.attention,1);assert.equal(board.filteredCounts.done,1);assert.equal(board.total,1);assert.equal(board.items[0].recordId,'recent-failed');
   assert.equal(taskBoard({journal:{db:tasks,assertAdmitted:()=>{}}},'human',{query:'recent-done'}).filteredCounts.all,1);
  }finally{tasks.close();}
 });
 console.log(JSON.stringify({passed:cases.length,cases}));
}finally{db.close();}
