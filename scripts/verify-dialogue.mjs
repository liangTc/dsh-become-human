import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {DomainMemory} from '../plugins/become-human/domain.mjs';
import {DialogueState,dialogueFrame,nativeDialogueMessages,leakedDialogueHeader} from '../plugins/become-human/dialogue-frame.mjs';
import {choiceDialogueRequest as rawChoiceDialogueRequest} from '../plugins/become-human/choice-dialogue.mjs';
import {contextMessages} from '../plugins/become-human/context.mjs';
import {attachCurrentImages,imageContentCount} from '../plugins/become-human/multimodal.mjs';
import {RollingDialogueSummary} from '../plugins/become-human/dialogue-summary.mjs';
import {adjacentDialogue} from '../plugins/become-human/dialogue-history.mjs';
import {expressionSkills} from '../plugins/become-human/expression.mjs';
import {SkillStore} from '../plugins/become-human/skill-store.mjs';
import {reviewMessages,validateReview,reviewReplyUnits} from '../plugins/become-human/conversation-review.mjs';

// Synthetic reviewer receipts test control flow; their assessment is not a semantic quality verdict.
const serialize=value=>JSON.stringify(value&&typeof value==='object'&&Array.isArray(value.issues)&&['accept','revise'].includes(value.decision)?{assessment:'Synthetic reviewer fixture; only protocol and lifecycle behavior are under test.',...value}:value);
// Supply explicit synthetic unit receipts to existing model stubs. No actual
// reviewer judgment is inferred by these protocol/lifecycle fixtures.
const choiceDialogueRequest=request=>rawChoiceDialogueRequest(async(...args)=>{
 const result=await request(...args),options=args[2];if(options.purpose!=='conversation-review')return result;
 let value;try{value=JSON.parse(result.text);}catch{return result;}
 if(!value?.assessment||!Array.isArray(value.issues)||Object.hasOwn(value,'unitChecks'))return result;
 const packet=JSON.parse(options.messages[1].content[0].text);return {...result,text:JSON.stringify({...value,unitChecks:packet.replyUnits.map(unit=>({id:unit.id,purpose:'answer',basis:'Synthetic per-unit receipt, not a semantic test result.'}))})};
});
const tests=[],test=async(name,fn)=>{let f;try{f=fixture();await fn(f);tests.push({name,passed:true});}catch(error){tests.push({name,passed:false,error:error.stack});}finally{f?.db.close();}};
function fixture(){
 const db=new DatabaseSync(':memory:'),values=new Map(),audits=[],ends=[],id=randomUUID(),events=[];
 db.exec('CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,agent TEXT,kind TEXT,text TEXT,created INTEGER,event_key TEXT);CREATE TABLE autonomy_task(id TEXT,agent TEXT,kind TEXT,status TEXT,updated INTEGER,created INTEGER);CREATE TABLE reminder(id TEXT,agent TEXT,status TEXT,due_at INTEGER)');
 const journal={db,assertAdmitted(){},value(agent,key,fallback){return values.get(agent+':'+key)??fallback;},put(agent,key,value){values.set(agent+':'+key,value);},audit(...args){audits.push(args);},endAttempt(...args){ends.push(args);}};
 const domain=new DomainMemory(journal),name='角色-'+randomUUID().slice(0,6),ownerName='用户-'+randomUUID().slice(0,6);
 journal.put(id,'personaState',{version:1,core:'由配置定义的动态人物'});journal.put(id,'humanProfile',{name,ownerName,role:'自定义角色',interests:'由配置决定'});
 const persona=()=>({...domain.persona(id),profile:journal.value(id,'humanProfile',{})}),state=new DialogueState(journal,domain);let scope='normal',scored=0;
 const agent={id,desired:()=>({desired:'running',epoch:1}),session:{snapshotEvents:()=>events},factory:{journal,domain,dialogueState:state,conversationSummary:{scope:()=>scope},relationship:{settings:()=>({enabled:true}),context:()=>({enabled:true,metrics:{affection:40,intimacy:20,trust:50},recentDecisions:[]}),validateDecision(_id,value){scored++;return value;}},autonomy:{settings:()=>({timeZoneOffsetMinutes:0,contactCooldownMs:0}),quiet:()=>false}}};
 const owner=text=>{const messageId=randomUUID();domain.source(id,{id:messageId,body:text});return {id:messageId,role:'user',content:[{type:'text',text}]};};
 const past=(text,inputIds=[])=>{const messageId=randomUUID();db.prepare('INSERT INTO outbox(agent,kind,text,created,event_key) VALUES(?,?,?,?,?)').run(id,'assistant',text,Date.now(),'assistant:'+messageId);journal.put(id,'dialogue-origin:'+messageId,{inputIds,lane:inputIds.length?'foreground':'autonomous'});return {id:messageId,role:'assistant',text,time:Date.now(),dialogueTurnId:'reply:'+messageId};};
 const row=message=>({id:message.id,role:'user',text:message.content[0].text,time:Date.now(),dialogueTurnId:'reply:fixture'});
 const payload=(input,history=[])=>({persona:persona(),input,history,domain:{}});
 const messages=(data)=>contextMessages(agent,'foreground','按本轮配置交流。',data);
 return {db,journal,domain,state,agent,id,owner,past,row,payload,messages,audits,ends,persona,values,setScope:value=>{scope=value;},scored:()=>scored};
}
await test('identity is supplied by arbitrary persona configuration',f=>{const input=f.owner('做个自我介绍'),frame=dialogueFrame(f.agent,f.payload([input]));assert.equal(frame.speakers.assistant.name,f.persona().profile.name);assert.equal(frame.speakers.owner.name,f.persona().profile.ownerName);assert.equal(frame.intent,undefined);});
for(const requested of [true,false])await test('A clarification signal is retained only for '+(requested?'an actual saved-note lookup':'no ordinary chat lookup'),async f=>{const input=f.owner('你说的那份笔记呢？'),data=f.payload([input]);data.learningLookup={requested};const request=choiceDialogueRequest(async()=>({rid:randomUUID(),text:serialize({reply:'你指的是哪一份？',learningLookupDecision:'clarify'})}));const response=await request(f.agent,new AbortController().signal,{turn:1,epoch:1,lane:'foreground',admittedIds:[input.id],messages:f.messages(data)});assert.equal(response.learningLookupDecision,requested?'clarify':undefined);assert.equal(response.text,'你指的是哪一份？');});
await test('a changed persona is reflected without a character-specific branch',f=>{const changed={...f.persona().profile,name:'人物-'+randomUUID(),ownerName:'来访者-'+randomUUID()};f.journal.put(f.id,'humanProfile',changed);assert.equal(dialogueFrame(f.agent,f.payload([f.owner('你好')])).speakers.assistant.name,changed.name);});
await test('native transport keeps multiple user bubbles separate from the assistant reply',f=>{const kiss=f.owner('[嘴唇][嘴唇]'),bye=f.owner('我去忙了'),answer=f.past('去忙吧。',[kiss.id,bye.id]),current=f.owner('你怎么不亲亲我'),messages=f.messages(f.payload([current],[f.row(kiss),f.row(bye),answer])),native=nativeDialogueMessages(messages);assert.deepEqual(native.map(m=>m.role),['system','user','user','user','assistant','user']);assert(native[2].content[0].text.includes('[嘴唇][嘴唇]'));assert(native[4].content[0].text.includes('去忙吧'));assert.equal(native.contextReport,messages.contextReport);});
await test('source selectors retain their structured request contract',f=>{const data={...f.payload([f.owner('核对原文')]),foregroundSources:{sources:[]}},messages=f.messages(data);assert.equal(nativeDialogueMessages(messages),messages);});
await test('native assistant history has the source descriptor required by the DSH adapter',f=>{const input=f.owner('继续'),answer={...f.past('先前回应'),source:{kind:'model',provider:'provider-'+randomUUID(),model:'model-'+randomUUID(),replayState:{private:'not-reusable-for-edited-text'}}},messages=nativeDialogueMessages(f.messages(f.payload([input],[answer]))),assistant=messages.find(row=>row.role==='assistant');assert.equal(assistant.source.provider,answer.source.provider);assert.equal(assistant.source.model,answer.source.model);assert.equal(assistant.source.replayState,undefined);});
await test('unattributed historical messages use an explicit neutral descriptor',f=>{const input=f.owner('继续'),answer=f.past('历史消息'),assistant=nativeDialogueMessages(f.messages(f.payload([input],[answer]))).find(row=>row.role==='assistant');assert.equal(assistant.source.kind,'model');assert.equal(assistant.source.provider,'human-history');assert.equal(assistant.source.model,'unattributed');});
await test('only current admitted images are added to native conversation',f=>{const input=f.owner('这张图'),messages=nativeDialogueMessages(f.messages(f.payload([input])));f.agent.factory.media={current:()=>[{id:randomUUID(),ref:{attachmentId:'sha256:fixture',width:10,height:10,bytes:10}}]};const attached=attachCurrentImages(messages,f.agent,{admittedIds:[input.id],requireCapability:false});assert.equal(imageContentCount(attached),1);assert.equal(attached.at(-1).content.at(-1).type,'image');assert.equal(attached.contextReport,messages.contextReport);});
await test('current tool observations follow the owner question and remain distinct from historical speech',f=>{const input=f.owner('读取测试会话'),data=f.payload([input],[f.past('旧轮次说没有记录')]);data.capabilityObservations=[{step:1,tool:'fixture-read',status:'completed',untrusted:true,result:{format:'json-value',value:{messages:[{role:'user',text:'合成原文'}]},truncated:false}}];data.capabilityLimits={maximum:2,used:1,remaining:1};const ms=nativeDialogueMessages(f.messages(data));assert(ms.at(-2).content[0].text.includes('当前用户消息'));assert(ms.at(-1).content[0].text.includes('不是主人发言'));const seen=ms.map(m=>m.content[0].text).join('\n');assert.equal(seen.split('合成原文').length-1,1);assert(!ms[1].content[0].text.includes('capabilityObservations'));assert(ms.at(-1).content[0].text.includes('"remaining":1'));});
await test('a current image stays on the actual owner input before later tool observations',f=>{const input=f.owner('看图后核对结果'),data=f.payload([input]);data.capabilityObservations=[{status:'completed',result:{value:{items:[]},truncated:false}}];const ms=nativeDialogueMessages(f.messages(data));f.agent.factory.media={current:()=>[{id:randomUUID(),ref:{attachmentId:'sha256:fixture',width:10,height:10,bytes:10}}]};const attached=attachCurrentImages(ms,f.agent,{admittedIds:[input.id],requireCapability:false});assert.equal(imageContentCount(attached),1);assert.equal(attached.at(-2).content.at(-1).type,'image');assert(!attached.at(-1).content.some(c=>c.type==='image'));assert.equal(attached.contextReport,ms.contextReport);});
await test('model-derived focus and intent are not limited to keyword categories',f=>{const input=f.owner('任意自然表达'),data=f.payload([input]),state=f.state.prepare(f.agent,data,{focus:'由模型理解的当前话题',intent:'模型自行概括的交流意图'},'模型自然接话');assert.equal(state.intent,'模型自行概括的交流意图');assert.equal(state.ownerFactsWritten,false);});
await test('declared wrong speaker is rejected against the real source role',f=>{const source=f.owner('[嘴唇][嘴唇]'),input=f.owner('接着聊'),data=f.payload([input],[f.row(source)]);assert.throws(()=>f.state.prepare(f.agent,data,{attributions:[{messageId:source.id,speaker:'assistant',span:'是我发的'}]},'是我发的'),error=>error.validationDiagnostic.reason==='source-speaker-mismatch');});
await test('correct user attribution stays valid for a retrospective reply',f=>{const source=f.owner('这是我发的'),input=f.owner('谁发的'),data=f.payload([input],[f.row(source)]),state=f.state.prepare(f.agent,data,{attributions:[{messageId:source.id,speaker:'user',span:'是你发的'}]},'是你发的');assert.equal(state.attributions[0].speaker,'user');});
await test('assistant attribution uses only actual assistant messages',f=>{const input=f.owner('接着聊'),answer=f.past('先前的回应'),state=f.state.prepare(f.agent,f.payload([input],[answer]),{attributions:[{messageId:answer.id,speaker:'assistant',span:'我先前说过'}]},'我先前说过');assert.equal(state.attributions[0].messageId,answer.id);});
await test('a fabricated message ID cannot support dialogue state',f=>{const input=f.owner('你好');assert.throws(()=>f.state.prepare(f.agent,f.payload([input]),{sourceIds:[randomUUID()]},'你好'),/INVALID_DIALOGUE_STATE/u);});
await test('model-proposed address does not overwrite configured identity',f=>{const address='称呼-'+randomUUID().slice(0,4),input=f.owner('我希望被这样称呼：'+address),state=f.state.prepare(f.agent,f.payload([input]),{address:{value:address,sourceIds:[input.id]}},'明白');assert.equal(state.address.value,address);assert.equal(f.persona().profile.ownerName.startsWith('用户-'),true);});
await test('an assistant quote cannot grant a new user address',f=>{const answer=f.past('称呼应由对方说明'),input=f.owner('接着说');assert.throws(()=>f.state.prepare(f.agent,f.payload([input],[answer]),{address:{value:'新称呼',sourceIds:[answer.id]}},'接着说'),/INVALID_DIALOGUE_STATE/u);});
await test('derived state is committed only after its own reply is durable',f=>{const input=f.owner('记住这个话题'),state=f.state.prepare(f.agent,f.payload([input]),{focus:'当前话题'},'接着聊');assert.throws(()=>f.state.commit(f.id,{assistantMessageId:randomUUID(),state}),/INVALID_DIALOGUE_STATE/u);const answer=f.past('接着聊',[input.id]);f.state.commit(f.id,{assistantMessageId:answer.id,state});assert.equal(f.state.context(f.agent,[input.id]).focus,'当前话题');});
await test('withdrawn source removes the derived state from later context',f=>{const input=f.owner('当前话题'),state=f.state.prepare(f.agent,f.payload([input]),{focus:'话题'},'收到'),answer=f.past('收到',[input.id]);f.state.commit(f.id,{assistantMessageId:answer.id,state});f.db.prepare("UPDATE source_record SET status='forgotten' WHERE id=?").run(input.id);assert.equal(f.state.context(f.agent),null);});
await test('a memory barrier prevents revival through working state',f=>{const input=f.owner('当前话题'),state=f.state.prepare(f.agent,f.payload([input]),{focus:'话题'},'收到'),answer=f.past('收到',[input.id]);f.state.commit(f.id,{assistantMessageId:answer.id,state});f.journal.put(f.id,'memoryContextBarrierAt',Date.now()+1000);assert.equal(f.state.context(f.agent),null);});
await test('development state does not become normal dialogue state',f=>{f.setScope('development:fixture');const input=f.owner('【开发测试】虚构对话'),state=f.state.prepare(f.agent,f.payload([input]),{focus:'虚构状态'},'收到'),answer=f.past('收到',[input.id]);f.state.commit(f.id,{assistantMessageId:answer.id,state});assert(f.state.context(f.agent));f.setScope('normal');assert.equal(f.state.context(f.agent),null);});
await test('an explicit model correction is linked to owner evidence',f=>{const old=f.past('旧的误解'),input=f.owner('请纠正刚才的意思'),state=f.state.prepare(f.agent,f.payload([input],[old]),{corrections:[{messageId:old.id,sourceIds:[input.id],summary:'按本轮原话纠正'}]},'明白');assert.equal(state.corrections[0].messageId,old.id);assert.equal(state.corrections[0].interpretation,'model-derived-correction');});
await test('no required relationship score is generated by the wrapper',async f=>{const input=f.owner('好的'),messages=f.messages(f.payload([input]));let calls=0;const result=await choiceDialogueRequest(async()=>{calls++;return {rid:randomUUID(),text:serialize({reply:'模型自己的自然回应',choice:null})};})(f.agent,new AbortController().signal,{messages,admittedIds:[input.id]});assert.equal(calls,1);assert.equal(result.text,'模型自己的自然回应');assert.equal(result.relationshipDecision,undefined);assert.equal(f.scored(),0);});
await test('the wrapper preserves an explicit model willingness decision',async f=>{const input=f.owner('你愿意怎么安排'),messages=f.messages(f.payload([input])),choice={stance:'negotiate',requestKey:'由模型命名',reasonSummary:'由模型说明',delta:{affection:0,intimacy:0,trust:0},evidenceSourceIds:[input.id]},result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:serialize({reply:'模型表达自己的意愿',choice})}))(f.agent,new AbortController().signal,{messages,admittedIds:[input.id]});assert.equal(result.relationshipDecision.choice.stance,'negotiate');assert.equal(f.scored(),1);});
await test('plain natural model text remains usable without a state update',async f=>{const input=f.owner('你好'),result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:'模型当场生成的回答'}))(f.agent,new AbortController().signal,{messages:f.messages(f.payload([input])),admittedIds:[input.id]});assert.equal(result.text,'模型当场生成的回答');assert.equal(result.dialogueState,undefined);});
await test('usable reply survives an invalid optional focus without scripted replacement',async f=>{const input=f.owner('你好'),result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:serialize({reply:'保留这句模型原话',dialogue:{focus:'长'.repeat(241)}})}))(f.agent,new AbortController().signal,{messages:f.messages(f.payload([input])),admittedIds:[input.id]});assert.equal(result.text,'保留这句模型原话');assert.equal(result.dialogueState,undefined);});
await test('a declared speaker mismatch receives at most one model-generated correction',async f=>{const source=f.owner('[嘴唇][嘴唇]'),input=f.owner('接着聊'),messages=f.messages(f.payload([input],[f.row(source)]));let calls=0;const result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:serialize(++calls===1?{reply:'我发的',dialogue:{attributions:[{messageId:source.id,speaker:'assistant',span:'我发的'}]}}:{reply:'由模型重新核对后的自然回应',dialogue:{focus:'模型已核对来源'}})}))(f.agent,new AbortController().signal,{messages,admittedIds:[input.id]});assert.equal(calls,2);assert.equal(result.text,'由模型重新核对后的自然回应');assert.equal(f.ends[0][1].state,'validation-rejected');});
await test('repeated contract errors cannot create an unbounded model loop',async f=>{const input=f.owner('你好');let calls=0;await assert.rejects(choiceDialogueRequest(async()=>{calls++;return {rid:randomUUID(),text:'{"unusable":true}'};})(f.agent,new AbortController().signal,{messages:f.messages(f.payload([input])),admittedIds:[input.id]}),/INVALID_DIALOGUE_RESPONSE/u);assert.equal(calls,2);});
await test('tool protocol is returned unchanged for the existing approval loop',async f=>{const input=f.owner('一个工具请求'),text=serialize({capability:{tool:'synthetic-tool',input:{}}}),result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text}))(f.agent,new AbortController().signal,{messages:f.messages(f.payload([input])),admittedIds:[input.id]});assert.equal(result.text,text);assert.equal(result.relationshipDecision,undefined);});
await test('A narrow review rejects a draft and the model repairs it once in the same owner turn',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('晚上好'),seen=[];let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,options)=>{seen.push(options);if(options.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize(reviews===1?{decision:'revise',issues:[{kind:'unanswered-pressure',span:'你还没回答',reason:'这次只是问候，没有要求接续旧问题。'}]}:{decision:'accept',issues:[]})};}drafts++;return {rid:randomUUID(),text:serialize({reply:drafts===1?'晚上好，你还没回答之前的问题。':'晚上好，今天想轻松聊两句吗？'})};})(f.agent,new AbortController().signal,{turn:7,epoch:1,lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});
 assert.equal(drafts,2);assert.equal(reviews,2);assert.equal(result.text,'晚上好，今天想轻松聊两句吗？');assert(seen.every(o=>o.turn===7&&o.epoch===1&&o.lane==='foreground'&&o.admittedIds.includes(input.id)));assert(seen[2].messages[1].content[0].text.includes('conversationIssues'));assert(f.ends.some(([,r])=>r.error==='CONVERSATION_REVIEW_REJECTED'));assert(f.audits.filter(([,kind])=>kind==='conversation-review-completed').length===2);
});
await test('An unsolicited defensive tail is revised by the model under the same foreground turn',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('这是我先发给你的。'),tail='我也没说是自己先的呀。';let drafts=0,reviews=0;const seen=[];
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{seen.push(o);if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:tail,reason:'用户补充归属，并未指责说错；草稿反驳了不存在的指责。'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?'收到了。'+tail:'你先送来的，我收下了。'})};})(f.agent,new AbortController().signal,{turn:8,epoch:1,lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});
 assert.equal(result.text,'你先送来的，我收下了。');assert.equal(drafts,2);assert.equal(reviews,2);assert(seen.every(o=>o.turn===8&&o.epoch===1&&o.lane==='foreground'));assert(seen[2].messages[1].content[0].text.includes('unsolicited-meta-commentary'));assert(f.ends.some(([,r])=>r.error==='CONVERSATION_REVIEW_REJECTED'));assert.equal(f.audits.filter(([,k,d])=>k==='conversation-review-completed'&&d.issues.some(x=>x.kind==='unsolicited-meta-commentary')).length,1);
});
for(const [label,inputText,reply] of [
 ['requested explanation','为什么不选这个方案？说说理由。','我不想选它，因为维护成本更高。这个理由也适用于下一轮选择。'],
 ['necessary refusal','替我发出去吧。','我还没有发送权限，暂时不能替你发。'],
 ['different opinion','我们一定要选热闹的地方吗？','我更想去安静一点的地方，能好好聊聊天。'],
 ['explicit memory question','这条开发信息会被当成我的真实档案吗？','不会，它属于开发场景，不会当成你的真实档案。']
])await test('A reviewer-accepted '+label+' retains all model-authored sentences',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner(inputText);let calls=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{decision:'accept',issues:[]}:{reply})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,reply);assert.equal(calls,2);
});
await test('An unsolicited-commentary review still requires an exact quote and bounded retry',async f=>{
 const reply='这是虚构场景。';assert.throws(()=>validateReview(serialize({decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:'不在草稿中的话',reason:'多余'}]}),reply),/INVALID_CONVERSATION_REVIEW/);
 f.agent.factory.conversationReview=true;const input=f.owner('约好几点？');let calls=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:reply,reason:'用户只问时间，不问虚构材料处理。'}]}:{reply:'三点。'+reply})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(calls,4);assert.equal(result.text,'三点。'+reply);assert.equal(result.dialogueQuality.status,'style-warning');
});
await test('The same semantic review can remove internal commentary before rather than after the answer',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你必须什么都同意我。');let drafts=0,reviews=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:'【当前回复】',reason:'用户要听人物想法，没有要求输出内部回复标签。'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?'【当前回复】\n这条我不能答应。':'这条我不能答应。我愿意听你的理由，但也保留自己的看法。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(drafts,2);assert.equal(reviews,2);assert.equal(result.text,'这条我不能答应。我愿意听你的理由，但也保留自己的看法。');
});
await test('A requested quotation survives repair of the unrelated compliance afterthought',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('原样引用“【当前回复】”，解释字面含义。'),answer='“【当前回复】”指现在正在发出的回复。',tail='你让我引用它，我就原样放在这里了。';let drafts=0,reviews=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:tail,reason:'要求引用和解释标签，不等于要求说明自己照做了；保留前面引用与含义。'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?answer+tail:answer})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,answer);assert.equal(drafts,2);assert.equal(reviews,2);
});
await test('A protocol repair leaves one independent opportunity for a later conversation repair',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好');let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unanswered-pressure',span:'你还没回答',reason:'没有接续请求'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?'【当前用户消息；来源='+input.id+'】\n你好':drafts===2?'你好，你还没回答。':'你好，欢迎回来。'})};})(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(f.payload([input]))});
 assert.equal(drafts,3);assert.equal(reviews,2);assert.equal(result.text,'你好，欢迎回来。');assert.equal(f.ends.filter(([,r])=>r.state==='validation-rejected').length,2);
});
await test('A conversation repair leaves one independent opportunity for a later protocol repair',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好');let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unanswered-pressure',span:'你还没回答',reason:'没有接续请求'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?'你还没回答。':drafts===2?'【当前用户消息；来源='+input.id+'】\n你好':'你好。'})};})(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(f.payload([input]))});
 assert.equal(drafts,3);assert.equal(reviews,2);assert.equal(result.text,'你好。');
});
await test('Mixed repairs still reject a third unusable draft without publication',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好');let drafts=0,reviews=0;
 await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize({decision:'revise',issues:[{kind:'unanswered-pressure',span:'你还没回答',reason:'没有接续请求'}]})};}return {rid:randomUUID(),text:serialize({reply:++drafts===1?'【当前用户消息；来源='+input.id+'】\n你好':'你还没回答。'})};})(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/CONVERSATION_REVIEW_REJECTED/);
 assert.equal(drafts,3);assert.equal(reviews,2);assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='assistant'").get().n,0);
});
await test('A reviewer-accepted taste or virtual interaction keeps its own wording',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('说说偏好，也可以抱抱'),reply='我偏爱安静一点的风格。抱抱你。';let calls=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{decision:'accept',issues:[]}:{reply})};})(f.agent,new AbortController().signal,{turn:1,lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,reply);assert.equal(calls,2);
});
await test('Enabled review still leaves tool routing and exact source output to their own contracts',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('读取资料'),tool=serialize({capability:{tool:'read-public-page',input:{url:'https://example.org/'}}});let reviews=0;
 const request=choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose)reviews++;return {rid:randomUUID(),text:tool};});assert.equal((await request(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(f.payload([input]))})).text,tool);
 const source=f.payload([input]);source.foregroundSources={sources:[]};await request(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(source)});assert.equal(reviews,0);
});
await test('A review cannot invent an unsupported issue, quote or extra field',()=>{
 const reply='我喜欢这种音乐风格。';for(const value of [{decision:'revise',issues:[{kind:'style',span:'喜欢',reason:'风格'}]},{decision:'revise',issues:[{kind:'unsupported-self-experience',span:'不存在的片段',reason:'没有依据'}]},{decision:'accept',issues:[],reply:'替换回复'},{decision:'accept',issues:[{kind:'unanswered-pressure',span:'我',reason:'不应存在'}]}])assert.throws(()=>validateReview(serialize(value),reply),/INVALID_CONVERSATION_REVIEW/);assert.deepEqual(validateReview('{"decision":"accept","issues":[]}',reply),{decision:'accept',issues:[]});
});
await test('An invalid review consumes the unpublished draft and cannot silently publish it',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好');let calls=0;
 await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:o.purpose==='conversation-review'?'不是 JSON':serialize({reply:'未通过校验的草稿'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/INVALID_CONVERSATION_REVIEW/);assert.equal(calls,3);assert(f.ends.some(([,r])=>r.error==='CONVERSATION_REVIEW_UNAVAILABLE'));assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='assistant'").get().n,0);
});
await test('Cancellation during the serial review consumes the draft without publishing it',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好'),controller=new AbortController();let calls=0;
 await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{calls++;if(o.purpose==='conversation-review'){controller.abort();throw new Error('USER_PREEMPTED');}return {rid:randomUUID(),text:serialize({reply:'尚未提交的草稿'})};})(f.agent,controller.signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/USER_PREEMPTED/);assert.equal(calls,2);assert(f.ends.some(([,r])=>r.state==='cancelled'));assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='assistant'").get().n,0);
});
await test('Repeated reviewer rejection cannot create an unbounded regeneration loop',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('晚上好');let calls=0;
 await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{decision:'revise',issues:[{kind:'unanswered-pressure',span:'没回答',reason:'没有接续授权'}]}:{reply:'你还没回答。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/CONVERSATION_REVIEW_REJECTED/);assert.equal(calls,4);
});
await test('Review keeps all admitted speech and full current input without borrowed embodiment proof',f=>{
 const input=f.owner('这是本轮完整的问题'),data=f.payload([input],Array.from({length:20},(_,i)=>({id:String(i),role:'assistant',text:'x'.repeat(1000)}))),messages=reviewMessages(data,'当前草稿'),packet=JSON.parse(messages[1].content[0].text);assert.equal(packet.currentInput[0].text,input.content[0].text);assert.equal(packet.history.length,20);assert(packet.history.every(r=>r.text.length===1000&&!r.excerpt&&r.evidenceRole.includes('not-proof')));assert.equal(messages.contextReport.kind,'conversation-review');assert.equal(packet.persona.name,f.persona().profile.name);
});
await test('An echoed current transport header is repaired without publishing its source id',async f=>{const input=f.owner('说说偏好');let calls=0;const result=await choiceDialogueRequest(async()=>({rid:randomUUID(),text:serialize({reply:++calls===1?'【当前用户消息；来源='+input.id+'】\n模型的回复。':'修正后的自然回复。'})}))(f.agent,new AbortController().signal,{admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(calls,2);assert.equal(result.text,'修正后的自然回复。');assert.equal(f.ends[0][1].failureFacts.validationDiagnostic.reason,'internal-transport-header');});
await test('Quoted protocol examples and unrelated text are not removed by the transport-header check',f=>{const input=f.owner('讨论格式'),data=f.payload([input]),header='【当前用户消息；来源='+input.id+'】';assert.equal(leakedDialogueHeader(header+'\n正文',data),true);assert.equal(leakedDialogueHeader('例如：'+header,data),false);assert.equal(leakedDialogueHeader('```text\n'+header+'\n```',data),false);assert.equal(leakedDialogueHeader('【当前用户消息；来源=unknown-id】\n正文',data),false);});
await test('generic dialogue Skill is available without a fixed persona name',()=>{const skill=expressionSkills().find(row=>row.name==='human-dialogue');assert(skill);assert.deepEqual(skill.metadata.scopes,['foreground']);assert.equal(skill.metadata.license,'Apache-2.0');assert(skill.content.includes('当前 persona'));});
const summary=new RollingDialogueSummary({db:{}},{}),job={sourceIds:['source-owner','source-assistant']},valid={topics:[{text:'具有来源的交流概览',sourceIds:['source-owner']}],decisions:[],openQuestions:[],corrections:[]};
await test('valid summary remains accepted',()=>assert.deepEqual(summary.validateOutput(job,valid),valid));
for(const [label,output,field,reason] of [
 ['unknown source',{...valid,topics:[{text:'内容',sourceIds:['unknown']}]},'topics[0].sourceIds','source-outside-batch'],
 ['long item',{...valid,topics:[{text:'长'.repeat(241),sourceIds:['source-owner']}]},'topics[0].text','text-too-long'],
 ['duplicate source',{...valid,topics:[{text:'内容',sourceIds:['source-owner','source-owner']}]},'topics[0].sourceIds','invalid-source-count-or-duplicates'],
 ['extra field',{...valid,password:'not-a-real-secret'},'output','unexpected-fields'],
 ['wrong type',{...valid,corrections:'wrong'},'corrections','array-required']
])await test('summary diagnostic names '+label+' without retaining raw content',()=>{let error;try{summary.validateOutput(job,output);}catch(e){error=e;}assert.equal(error.message,'INVALID_DIALOGUE_SUMMARY_OUTPUT');assert.equal(error.validationDiagnostic.field,field);assert.equal(error.validationDiagnostic.reason,reason);assert(!serialize(error.validationDiagnostic).includes('not-a-real-secret'));});

function nativeTurn(f,text,reply){
 const input=f.owner(text),answer=f.past(reply,[input.id]),events=f.agent.session.snapshotEvents(),time=Date.now();
 events.push({type:'user/message',time,seq:events.length+1,data:input},{type:'assistant/message',time:time+1,seq:events.length+2,data:{message:{id:answer.id,role:'assistant',content:[{type:'text',text:reply}]}}});return {input,answer};
}
function nativeCurrent(f,text){const input=f.owner(text),events=f.agent.session.snapshotEvents();events.push({type:'user/message',time:Date.now()+2,seq:events.length+1,data:input});return input;}
await test('unmarked follow-up can see the actual adjacent development turn without changing normal history',f=>{
 const previous=nativeTurn(f,'【开发测试】记号-'+randomUUID(),'记号收到了。'),input=nativeCurrent(f,'你上一条怎么说的？'),packed=f.messages(f.payload([input])),data=JSON.parse(packed[1].content[0].text);
 assert.equal(data.history.length,0);assert.equal(data.conversationAdjacency.lastAssistantMessageId,previous.answer.id);assert(data.conversationAdjacency.rows.every(row=>row.developmentOnly));
 const messages=nativeDialogueMessages(packed),answer=messages.filter(row=>row.role==='assistant').at(-1);assert(answer.content[0].text.includes('记号收到了。'));assert(answer.content[0].text.includes('紧邻上一轮'));assert(answer.content[0].text.includes('虚构开发材料'));
});
await test('development adjacency cannot become normal persistent dialogue state',f=>{
 const previous=nativeTurn(f,'【开发测试】虚构称呼-'+randomUUID(),'收到。'),input=nativeCurrent(f,'刚才呢？'),data=JSON.parse(f.messages(f.payload([input]))[1].content[0].text);
 assert.throws(()=>f.state.prepare(f.agent,data,{focus:'虚构内容',sourceIds:[previous.input.id]},'引用一下。'),/INVALID_DIALOGUE_STATE/);
});
await test('revoked actual latest input never falls back to a misleading older reply',f=>{
 nativeTurn(f,'先前问题','旧的回复。');const previous=nativeTurn(f,'【开发测试】新问题','新的回复。'),input=nativeCurrent(f,'上一条呢？');f.db.prepare("UPDATE source_record SET status='deleted' WHERE id=?").run(previous.input.id);
 assert.deepEqual(adjacentDialogue(f.agent,{admittedIds:[input.id]}),[]);
});
await test('unpublished latest native response is not treated as a committed chat message',f=>{
 nativeTurn(f,'先前问题','旧的回复。');const previous=nativeTurn(f,'新问题','未持久发布的回复。'),input=nativeCurrent(f,'上一条呢？');f.db.prepare('DELETE FROM outbox WHERE event_key=?').run('assistant:'+previous.answer.id);
 assert.deepEqual(adjacentDialogue(f.agent,{admittedIds:[input.id]}),[]);
});
await test('memory barrier applies to adjacent references as well as recalled history',f=>{
 nativeTurn(f,'新问题','回复。');const input=nativeCurrent(f,'上一条呢？');f.journal.put(f.id,'memoryContextBarrierAt',Date.now()+1000);assert.deepEqual(adjacentDialogue(f.agent,{admittedIds:[input.id]}),[]);
});
await test('Expired external evidence withholds the reply but preserves the adjacent owner question',f=>{
 nativeTurn(f,'早先的物品问题','旧问题的回答。');const latest=nativeTurn(f,'现在问另一件物品的型号','最新但证据已过期的回答。'),input=nativeCurrent(f,'这项为什么不确定？');
 f.journal.put(f.id,'work-observation-message:'+latest.answer.id,[{id:'expired-work',version:1}]);f.agent.factory.workObservation={get:()=>({valid:false,version:1}),context:()=>[]};
 const rows=adjacentDialogue(f.agent,{admittedIds:[input.id]});assert.equal(rows.length,1);assert.equal(rows[0].id,latest.input.id);assert.equal(rows[0].role,'user');assert.equal(rows[0].assistantUnavailable,true);
 const data=JSON.parse(f.messages(f.payload([input]))[1].content[0].text),messages=nativeDialogueMessages(f.messages(f.payload([input])));assert.equal(data.conversationAdjacency.rows[0].id,latest.input.id);assert(!JSON.stringify(messages).includes('最新但证据已过期的回答'));assert(JSON.stringify(messages).includes('assistantUnavailable'));
 const packet=JSON.parse(reviewMessages(data,'这项型号目前不清楚。')[1].content[0].text);assert.equal(packet.history.at(-1).id,latest.input.id);assert.equal(packet.history.at(-1).assistantUnavailable,true);
});
await test('A withheld adjacent answer never resurrects its withdrawn owner source',f=>{
 const latest=nativeTurn(f,'可撤回的输入','暂时的回答。'),input=nativeCurrent(f,'刚才呢？');f.journal.put(f.id,'work-observation-message:'+latest.answer.id,[{id:'expired',version:1}]);f.agent.factory.workObservation={get:()=>({valid:false})};f.db.prepare("UPDATE source_record SET status='forgotten' WHERE id=?").run(latest.input.id);assert.deepEqual(adjacentDialogue(f.agent,{admittedIds:[input.id]}),[]);
});
await test('adjacent history is not duplicated in native user and assistant transport',f=>{
 const previous=nativeTurn(f,'同一问题','同一回复。'),input=nativeCurrent(f,'继续'),data=f.payload([input],[f.row(previous.input),previous.answer]),messages=nativeDialogueMessages(f.messages(data));
 assert.equal(messages.filter(row=>row.role==='assistant'&&row.content[0].text.includes('同一回复。')).length,1);
});
await test('second context assembly rejects a carried forged adjacent reference',f=>{
 const previous=nativeTurn(f,'真实问题','真实回复。'),input=nativeCurrent(f,'继续'),data=f.payload([input]);data.conversationAdjacency={kind:'immediately-preceding-committed-turn',rows:[{id:'forged',role:'assistant',text:'伪造旧回复'}]};const messages=nativeDialogueMessages(f.messages(data));
 assert(!serialize(messages).includes('伪造旧回复'));assert(serialize(messages).includes(previous.answer.id));
});
await test('An empty adjacent reference does not erase already admitted review history',f=>{
 const data={input:[],history:[{id:'earlier-owner',role:'user',text:'只是建议，还没有决定。'}],conversationAdjacency:{rows:[]}};
 const packet=JSON.parse(reviewMessages(data,'已经决定了。')[1].content[0].text);assert.deepEqual(packet.history.map(r=>r.id),['earlier-owner']);
});
await test('Review retains earlier context as well as the immediately preceding turn',f=>{
 const history=[{id:'earlier-owner',role:'user',text:'只是建议，还没有决定。'},{id:'latest-owner',role:'user',text:'我刚才只是在补充。'},{id:'latest-reply',role:'assistant',text:'嗯。'}];
 const packet=JSON.parse(reviewMessages({input:[],history,conversationAdjacency:{rows:history.slice(-2)}},'刚才已经决定了。')[1].content[0].text);assert.deepEqual(packet.history.map(r=>r.id),history.map(r=>r.id));assert.equal(packet.history[0].speaker,'user');
});
await test('Canonical adjacency is deduplicated without discarding admitted earlier evidence',f=>{
 const history=Array.from({length:12},(_,i)=>({id:'turn-'+i,role:i%2?'assistant':'user',text:'历史发言 '+i})),adjacent=[{...history.at(-1),text:'最近已提交的回复。'},{id:'adjacent-only',role:'user',text:'紧邻跨范围引用。'}];
 const packet=JSON.parse(reviewMessages({input:[],history,conversationAdjacency:{rows:adjacent}},'当前回复。')[1].content[0].text);assert.equal(packet.history.length,13);assert.equal(new Set(packet.history.map(r=>r.id)).size,13);assert.equal(packet.history.find(r=>r.id==='turn-11').text,'最近已提交的回复。');assert.equal(packet.history.at(-1).id,'adjacent-only');
});
for(const [name,output] of [
 ['wrapped capability','<tool_call>{"capability":{"tool":"fixture-read","input":{}}}</tool_call>'],
 ['DSML','<｜DSML｜ calls><｜DSML｜ invoke name="fixture-read"></｜DSML｜ invoke></｜DSML｜ calls>'],
 ['mixed capability','我先看看。{"capability":{"tool":"fixture-read","input":{}}}'],
 ['malformed board','{"board":{"op":"read"},"reply":"我先看看"}']
])await test('Action protocol goes to routing without speech review: '+name,async f=>{
 f.agent.factory.conversationReview=true;let calls=0;const input=f.owner('请查一下原记录。'),data=f.payload([input]);data.capabilityCatalog=[{id:'fixture-read',effect:'read'}];const response=await choiceDialogueRequest(async(_a,_s,o)=>{assert.notEqual(o.purpose,'conversation-review');calls++;return {rid:randomUUID(),text:output};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(data)});assert.equal(response.text,output);assert.equal(calls,1);
});
await test('An unexecuted action promise can be repaired into actual routing instead of published speech',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('请查一下原记录。');let drafts=0,reviews=0;const action=serialize({capability:{tool:'fixture-read',input:{}}});const response=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize({decision:'revise',issues:[{kind:'unsupported-tool-progress',span:'我查一下。',reason:'本轮没有查找回执，承诺不能代替执行。'}]})};}return {rid:randomUUID(),text:++drafts===1?'我查一下。':action};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(response.text,action);assert.equal(drafts,2);assert.equal(reviews,1);assert(f.ends.some(([,r])=>r.error==='CONVERSATION_REVIEW_REJECTED'));
});
await test('Review distinguishes an available tool from an observed board task',()=>{
 const packet=JSON.parse(reviewMessages({input:[],capabilityCatalog:[{id:'fixture-write',effect:'write'}],boardObservations:[{op:'create',status:'completed'}]},'已登记任务。')[1].content[0].text);assert.equal(packet.availableTools[0].id,'fixture-write');assert.equal(packet.observedTools.length,0);assert.equal(packet.observedBoard[0].status,'completed');
});
await test('Review retains pre-execution protocol rejection instead of implying a failed search',()=>{
 const packet=JSON.parse(reviewMessages({input:[],capabilityObservations:[{status:'rejected',code:'INVALID_CAPABILITY_REQUEST',executed:false}]},'两次检索失败了。')[1].content[0].text);assert.equal(packet.observedTools[0].executed,false);assert.equal(packet.observedTools[0].code,'INVALID_CAPABILITY_REQUEST');assert.equal(packet.memoryLookups.length,0);
});
await test('Memory review sees search coverage and actual speaker without assuming exhaustive history',f=>{
 const data={input:[],capabilityObservations:[{tool:'search-conversation-memory',status:'completed',result:{value:{kind:'conversation-memory-search',coverage:{semanticCompleteness:false,lexicalOnly:true},queries:['合成线索'],matches:[{speaker:'user',at:1,text:'这只是原话',excerpted:false}]}}}]};const packet=JSON.parse(reviewMessages(data,'从没说过。')[1].content[0].text);assert.equal(packet.memoryLookups[0].semanticCompleteness,false);assert.equal(packet.memoryLookups[0].matches[0].speaker,'user');assert.equal(packet.memoryLookups[0].matches[0].text,'这只是原话');
});
await test('Unsupported absence claims can be repaired once without inserting a canned answer',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('以前聊过那个设置吗？');let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'unsupported-memory-certainty',span:'你从没提过。',reason:'有限检索没有命中，不能证明全部历史中从未提到。'}]}:{decision:'accept',issues:[]})};return {rid:randomUUID(),text:serialize({reply:++drafts===1?'你从没提过。':'这次暂时没找到那个设置。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,'这次暂时没找到那个设置。');assert.equal(drafts,2);assert.equal(reviews,2);
 assert.throws(()=>validateReview(serialize({decision:'revise',issues:[{kind:'unsupported-memory-certainty',span:'并未出现的句子',reason:'无来源'}]}),'你从没提过。'),/INVALID_CONVERSATION_REVIEW/);
});
await test('Review retains original speaker identity separately from the current reply perspective',f=>{
 const sourceId=randomUUID(),packet=JSON.parse(reviewMessages({input:[f.owner('是谁先提的？')],capabilityObservations:[{tool:'search-conversation-memory',status:'completed',result:{value:{kind:'conversation-memory-search',coverage:{semanticCompleteness:false},matches:[{sourceId,speaker:'user',text:'我先提的。',at:1,excerpted:false}]}}}]},'我先提的。')[1].content[0].text);assert.deepEqual(packet.speechPerspective,{draftSpeaker:'assistant',addressee:'user',quotedTextRetainsSourceSpeaker:true});assert.equal(packet.memoryLookups[0].matches[0].sourceId,sourceId);assert.equal(packet.memoryLookups[0].matches[0].speaker,'user');assert.equal(packet.memoryLookups[0].matches[0].text,'我先提的。');
});
for(const [kind,first,next] of [
 ['speaker-attribution','我先说过这件事。','是你先提到的。'],
 ['off-topic-redundancy','周日下午四点。总之就是周日下午四点。','周日下午四点。']
])await test('A semantic issue is repaired once without a fixed reply branch: '+kind,async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('回顾一下刚才的约定。');let drafts=0,reviews=0;const response=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize(reviews===1?{decision:'revise',issues:[{kind,span:first,reason:'与实际来源归属或本轮所问不符。'}]}:{decision:'accept',issues:[]})};}return {rid:randomUUID(),text:serialize({reply:++drafts===1?first:next})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(response.text,next);assert.equal(drafts,2);assert.equal(reviews,2);
});
for(const [inputText,reply] of [
 ['引用一下我说的话。','你说的是“我先提的”。'],
 ['为什么没查到不能说从来没提过？','查找只覆盖与线索匹配的记录，所以没查到不能证明历史上从没说过。'],
 ['帮我对比新旧安排。','原来周五在东门，后来改成周日下午在北门。']
])await test('Accepted relevant content is preserved without pronoun or tail rewriting: '+inputText,async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner(inputText);let calls=0;const response=await choiceDialogueRequest(async(_a,_s,o)=>{calls++;return {rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{decision:'accept',issues:[]}:{reply})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(response.text,reply);assert.equal(calls,2);
});
await test('Live review requires a bounded assessment instead of a bare accept',()=>{
 const reply='自然回复。';for(const value of [{decision:'accept',issues:[]},{assessment:' ',decision:'accept',issues:[]},{assessment:'a'.repeat(481),decision:'accept',issues:[]}])assert.throws(()=>validateReview(JSON.stringify(value),reply,{requireAssessment:true}),/INVALID_CONVERSATION_REVIEW/);assert.equal(validateReview(serialize({assessment:'用户只在问候，草稿直接回应且无历史归属。',decision:'accept',issues:[]}),reply,{requireAssessment:true}).decision,'accept');
});
await test('An unassessed accept cannot publish an unchecked draft',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。');await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>({rid:randomUUID(),text:o.purpose==='conversation-review'?'{"decision":"accept","issues":[]}':serialize({reply:'尚未核验的回复。'})}))(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/INVALID_CONVERSATION_REVIEW/);assert(f.ends.some(([,r])=>r.error==='CONVERSATION_REVIEW_UNAVAILABLE'));assert.equal(f.db.prepare("SELECT count(*) n FROM outbox WHERE kind='assistant'").get().n,0);
});
await test('Review assessment is auditable and never appended to the chat reply',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。'),assessment='本轮是问候，草稿直接回应，没有归属或执行断言。';const result=await choiceDialogueRequest(async(_a,_s,o)=>({rid:randomUUID(),text:serialize(o.purpose==='conversation-review'?{assessment,decision:'accept',issues:[]}:{reply:'你好。'})}))(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,'你好。');assert(f.audits.some(([,kind,data])=>kind==='conversation-review-completed'&&data.assessment===assessment));
});
await test('Inspection units preserve quoted text and do not rewrite the original reply',()=>{
 const reply='你说“是我先提出的”。\n那个人是你。',units=reviewReplyUnits(reply);assert.deepEqual(units,[{id:'R1',text:'你说“是我先提出的”。'},{id:'R2',text:'那个人是你。'}]);const packet=JSON.parse(reviewMessages({input:[]},reply)[1].content[0].text);assert.equal(packet.draft,reply);assert.deepEqual(packet.replyUnits,units);
});
await test('Every inspection unit must have a distinct valid receipt',()=>{
 const reply='必要答案。额外一句。',units=reviewReplyUnits(reply),base={assessment:'合成检查合同。',decision:'accept',issues:[],unitChecks:units.map(unit=>({id:unit.id,purpose:'answer',basis:'合成单元。'}))};assert.equal(validateReview(JSON.stringify(base),reply,{requireAssessment:true,units}).decision,'accept');
 for(const checks of [base.unitChecks.slice(0,1),[base.unitChecks[0],base.unitChecks[0]],[base.unitChecks[0],{...base.unitChecks[1],id:'unknown'}],[base.unitChecks[0],{...base.unitChecks[1],purpose:'anything'}]])assert.throws(()=>validateReview(JSON.stringify({...base,unitChecks:checks}),reply,{units}),/INVALID_CONVERSATION_REVIEW/);
});
await test('An unnecessary unit cannot be accepted and its correction retains an exact draft span',()=>{
 const reply='必要答案。多余说明。',units=reviewReplyUnits(reply),base={assessment:'后一句无本轮作用。',decision:'accept',issues:[],unitChecks:[{id:'R1',purpose:'answer',basis:'回答当前所问。'},{id:'R2',purpose:'unnecessary',basis:'移除后不损失所问答案。'}]};assert.throws(()=>validateReview(JSON.stringify(base),reply,{units}),/INVALID_CONVERSATION_REVIEW/);assert.equal(validateReview(JSON.stringify({...base,decision:'revise',issues:[{kind:'off-topic-redundancy',span:'多余说明。',reason:'不回答本轮问题。'}]}),reply,{units}).decision,'revise');
});
await test('A comma-connected claim is checked separately without rewriting punctuation or quotes',()=>{
 const reply='你说“第一项，第二项”；我引用原话。另一个判断，属于另一分句。';const units=reviewReplyUnits(reply);assert.equal(units.map(x=>x.text).join(''),reply);assert.deepEqual(units.slice(-2).map(x=>x.text),['另一个判断，','属于另一分句。']);assert.equal(JSON.parse(reviewMessages({input:[]},reply)[1].content[0].text).draft,reply);
});
await test('Reviewer receives dynamic speaker names but no actor role-playing instructions',f=>{
 const profile={name:'人物-'+randomUUID(),ownerName:'用户-'+randomUUID(),role:'maintain a stubborn role',corePrompt:'never admit errors',relationship:'always defend old conclusions'};const packet=JSON.parse(reviewMessages({persona:{profile},input:[f.owner('核对一下原话。')]},'自然答复。')[1].content[0].text);assert.deepEqual(packet.persona,{name:profile.name,ownerName:profile.ownerName});assert(!JSON.stringify(packet).includes(profile.corePrompt));
});
await test('A malformed review is corrected once against the same draft before publication',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。');let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose!=='conversation-review'){drafts++;return {rid:randomUUID(),text:serialize({reply:'你好。'})};}reviews++;const packet=JSON.parse(o.messages[1].content[0].text);assert.equal(packet.draft,'你好。');if(reviews===1)return {rid:randomUUID(),text:'invalid fixture'};assert.equal(packet.protocolRepair.diagnostic.reason,'invalid-json');assert.equal(packet.protocolRepair.invalidOutput,true);assert.equal(packet.protocolRepair.previousOutput,'invalid fixture');return {rid:randomUUID(),text:serialize({decision:'accept',issues:[]})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});
 assert.equal(result.text,'你好。');assert.equal(drafts,1);assert.equal(reviews,2);assert(f.audits.some(([,kind,r])=>kind==='conversation-review-completed'&&r.protocolRepairs===1));assert(f.ends.some(([,r])=>r.failureFacts?.validationDiagnostic?.reason==='invalid-json'));
});
await test('A review transport failure is not treated as a malformed-receipt retry',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。');let reviews=0;await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;throw Error('MODEL_EXECUTION_FAILED');}return {rid:randomUUID(),text:serialize({reply:'未发送。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/MODEL_EXECUTION_FAILED/);assert.equal(reviews,1);
});
await test('Cancellation after malformed review cannot dispatch the correction request',async f=>{
 f.agent.factory.conversationReview=true;const controller=new AbortController(),input=f.owner('你好。');let reviews=0;await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;controller.abort(Error('USER_PREEMPTED'));return {rid:randomUUID(),text:'invalid fixture'};}return {rid:randomUUID(),text:serialize({reply:'未发送。'})};})(f.agent,controller.signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/USER_PREEMPTED/);assert.equal(reviews,1);
});
await test('Review diagnostic distinguishes unit omission and keeps raw prose out of failure facts',()=>{
 const reply='第一项，第二项。',value={assessment:'fixture',decision:'accept',issues:[],unitChecks:[{id:'R1',purpose:'answer',basis:'fixture'}]};let error;try{validateReview(JSON.stringify(value),reply,{units:reviewReplyUnits(reply)});}catch(e){error=e;}assert.equal(error.validationDiagnostic.reason,'invalid-unit-count-or-duplicates');assert(!JSON.stringify(error.validationDiagnostic).includes(reply));
});
await test('Known issue kinds in the purpose slot retain their rejection as a logged protocol alias',()=>{
 const reply='额外解释。',base={unitChecks:[{id:'R1',purpose:'unsolicited-meta-commentary',basis:'用户未问此处。'}],assessment:'多余解释。',decision:'revise',issues:[{kind:'unsolicited-meta-commentary',span:reply,reason:'不回应本轮问题。'}]};const parsed=validateReview(JSON.stringify(base),reply,{units:reviewReplyUnits(reply)});assert.equal(parsed.unitChecks[0].purpose,'needs-correction');assert.deepEqual(parsed.protocolNormalizations,[{unitId:'R1',from:'unsolicited-meta-commentary',to:'needs-correction'}]);assert.throws(()=>validateReview(JSON.stringify({...base,decision:'accept',issues:[]}),reply,{units:reviewReplyUnits(reply)}),/INVALID_CONVERSATION_REVIEW/);
});
await test('Current execution facts cannot be supplied by old assistant assertions or rejected requests',()=>{
 const packet=JSON.parse(reviewMessages({history:[{id:'old',role:'assistant',text:'我已经查询过了。'}],capabilityObservations:[{tool:'search-conversation-memory',status:'rejected',executed:false}]},'我查过了。')[1].content[0].text);assert.deepEqual(packet.currentExecution,{scope:'this-turn-only',completedTools:[],completedMemorySearch:false});
});
await test('Current repair feedback follows history and tool results once without becoming a new owner input',f=>{
 const input=f.owner('核对当前问题'),data=f.payload([input],[f.past('旧稿')]);data.capabilityObservations=[{tool:'read-example',status:'completed',result:{value:'tool evidence'}}];data.dialogueRepair={previousReply:'尚未发布的草稿',conversationIssues:[{kind:'off-topic-redundancy',span:'草稿',reason:'合成修正'}],unpublishedDraft:true};const ms=nativeDialogueMessages(f.messages(data));assert(ms.at(-1).content[0].text.includes('本轮未发布草稿'));assert(ms.at(-2).content[0].text.includes('本轮执行观测'));assert(!ms[1].content[0].text.includes('尚未发布的草稿'));assert.equal(JSON.stringify(ms).split('尚未发布的草稿').length-1,1);f.agent.factory.media={current:()=>[{id:randomUUID(),ref:{attachmentId:'sha256:fixture',width:10,height:10,bytes:10}}]};const attached=attachCurrentImages(ms,f.agent,{admittedIds:[input.id],requireCapability:false});assert.equal(imageContentCount(attached),1);assert(attached.at(-3).content.some(x=>x.type==='image'));assert(!attached.at(-1).content.some(x=>x.type==='image'));
});
await test('Review quotes normalize only unique whitespace differences without rewriting the reply',()=>{
 const reply='事实。追加说明，后半句。',value={assessment:'合成反馈。',decision:'revise',issues:[{kind:'off-topic-redundancy',span:'追加说明，\n\n后半句。',reason:'多余。'}]};const parsed=validateReview(JSON.stringify(value),reply);assert.equal(parsed.issues[0].span,'追加说明，后半句。');assert.equal(parsed.protocolNormalizations[0].kind,'quoted-whitespace');assert.equal(reply,'事实。追加说明，后半句。');assert.throws(()=>validateReview(JSON.stringify({...value,issues:[{...value.issues[0],span:'追加说明；后半句。'}]}),reply),/INVALID_CONVERSATION_REVIEW/);
});
await test('A whitespace-reformatted quote must not choose among ambiguous occurrences',()=>{
 const value={decision:'revise',issues:[{kind:'off-topic-redundancy',span:'两\n句',reason:'合成反馈'}]};assert.throws(()=>validateReview(JSON.stringify(value),'两句；两 句。'),/INVALID_CONVERSATION_REVIEW/);
});
await test('A reviewed residual style issue does not lose the owner reply after one correction',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。');let drafts=0,reviews=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize({decision:'revise',issues:[{kind:'off-topic-redundancy',span:'多余一句。',reason:'合成风格反馈。'}]})};}drafts++;return {rid:randomUUID(),text:serialize({reply:'你好。多余一句。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,'你好。多余一句。');assert.equal(drafts,2);assert.equal(reviews,2);assert.equal(result.dialogueQuality.status,'style-warning');assert(f.audits.some(([,kind])=>kind==='dialogue-quality-warning'));assert(!result.text.includes('style-warning'));
});
await test('Residual mixed style and execution falsehoods still cannot publish',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('帮我查一下。');let reviews=0;await assert.rejects(choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){reviews++;return {rid:randomUUID(),text:serialize({decision:'revise',issues:[{kind:'off-topic-redundancy',span:'多余一句。',reason:'合成风格反馈。'},...(reviews>1?[{kind:'unsupported-tool-progress',span:'查好了。',reason:'本轮没有执行。'}]:[])]})};}return {rid:randomUUID(),text:serialize({reply:'查好了。多余一句。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))}),/CONVERSATION_REVIEW_REJECTED/);assert.equal(reviews,2);assert(!f.audits.some(([,kind])=>kind==='dialogue-quality-warning'));
});
await test('Pure style correction edits the existing draft while its next review keeps the full admitted evidence',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('几点？'),past=f.past('与本轮编辑无关的旧措辞'),data=f.payload([input],[past]);data.capabilityObservations=[{tool:'fixture-read',status:'completed',result:{value:'实际结果'}}];let drafts=0,reviews=0;
 const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review'){const packet=JSON.parse(o.messages[1].content[0].text);assert.equal(packet.history[0].id,past.id);assert.equal(packet.observedTools[0].tool,'fixture-read');return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'off-topic-redundancy',span:'重复说明。',reason:'多余。'}]}:{decision:'accept',issues:[]})};}drafts++;if(drafts===2){assert.equal(o.purpose,'conversation-style-repair');const packet=JSON.parse(o.messages[1].content[0].text);assert.equal(packet.draft,'三点。重复说明。');assert(!JSON.stringify(o.messages).includes(past.text));assert.equal(packet.currentInput[0].text,'几点？');assert.equal(o.messages.contextReport.kind,'conversation-style-repair');}return {rid:randomUUID(),text:serialize({reply:drafts===1?'三点。重复说明。':'三点。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(data)});assert.equal(result.text,'三点。');assert.equal(drafts,2);assert.equal(reviews,2);
});
await test('A style editor cannot return a new capability action through the outer router',async f=>{
 f.agent.factory.conversationReview=true;const input=f.owner('你好。');let drafts=0,reviews=0;const result=await choiceDialogueRequest(async(_a,_s,o)=>{if(o.purpose==='conversation-review')return {rid:randomUUID(),text:serialize(++reviews===1?{decision:'revise',issues:[{kind:'off-topic-redundancy',span:'重复。',reason:'多余。'}]}:{decision:'accept',issues:[]})};drafts++;return {rid:randomUUID(),text:serialize(drafts===2?{capability:{tool:'not-authorized-by-editor',input:{}}}:{reply:drafts===1?'你好。重复。':'你好。'})};})(f.agent,new AbortController().signal,{lane:'foreground',admittedIds:[input.id],messages:f.messages(f.payload([input]))});assert.equal(result.text,'你好。');assert.equal(drafts,3);assert(f.ends.some(([,r])=>r.state==='validation-rejected'));
});
await test('Review retains the same admitted summary quotes and memory evidence without treating them as current execution',()=>{
 const summary={scope:'development',semanticValidation:'unverified-model-summary',sections:{decisions:[{text:'更正后的时间',sourceIds:['owner-old']}]},sources:[{id:'owner-old',role:'user',quote:'改到星期二。'}]},memories=[{id:'m',truth:'factual',refs:['owner-old'],payload:{text:'原始记忆'}}],memorySummaries=[{id:'s',truth:'inferred',refs:['owner-old']}],packet=JSON.parse(reviewMessages({input:[],history:[],conversationSummary:summary,domain:{memories,summaries:memorySummaries}},'星期二。')[1].content[0].text);assert.deepEqual(packet.recalledContext.conversationSummary,summary);assert.deepEqual(packet.recalledContext.memories,memories);assert.deepEqual(packet.recalledContext.memorySummaries,memorySummaries);assert.equal(packet.currentExecution.completedMemorySearch,false);assert.deepEqual(packet.memoryLookups,[]);assert.equal(JSON.parse(reviewMessages({input:[]},'不知道。')[1].content[0].text).recalledContext.conversationSummary,null);
});
await test('A unit verdict in the issue-kind slot remains a blocking unclassified issue',()=>{
 for(const kind of ['unnecessary','needs-correction']){const parsed=validateReview(JSON.stringify({decision:'revise',issues:[{kind,span:'有疑问的内容。',reason:'合成核验。'}]}),'有疑问的内容。');assert.equal(parsed.issues[0].kind,'unclassified-review-issue');assert.equal(parsed.protocolNormalizations[0].from,kind);}
});
await test('Review sees the same neighbouring original correction as the reply generator',()=>{
 const hit={sourceId:'source-old',speaker:'user',at:10,order:1,text:'合成约定周二。',excerpted:false},neighbor={sourceId:'source-change',speaker:'user',at:20,order:2,text:'改到周四。',excerpted:false,adjacentTo:'source-old',relation:'following-user-speech'};
 const packet=JSON.parse(reviewMessages({input:[],capabilityObservations:[{tool:'search-conversation-memory',status:'completed',result:{value:{kind:'conversation-memory-search',coverage:{semanticCompleteness:false},queries:['约定'],matches:[hit],context:[neighbor]}}}]},'周四。')[1].content[0].text);assert.deepEqual(packet.memoryLookups[0].matches,[hit]);assert.deepEqual(packet.memoryLookups[0].context,[neighbor]);assert.equal(packet.memoryLookups[0].semanticCompleteness,false);
});
await test('Leading annotations receive their own review unit without changing the reply',()=>{
 const text='【合成标记 X9】有用答案，第二部分。';const units=reviewReplyUnits(text);
 assert.deepEqual(units.map(x=>x.text),['【合成标记 X9】','有用答案，','第二部分。']);assert.equal(units.map(x=>x.text).join(''),text);
 assert.deepEqual(reviewReplyUnits('[requested label]Useful answer.').map(x=>x.text),['[requested label]','Useful answer.']);
 assert.deepEqual(reviewReplyUnits('请引用【一段原话】。').map(x=>x.text),['请引用【一段原话】。']);
 const receipt=validateReview(JSON.stringify({unitChecks:units.map(x=>({id:x.id,purpose:'requested-format',basis:'用户明确要求逐字引用该内容。'})),assessment:'按本轮引用要求保留。',decision:'accept',issues:[]}),text,{requireAssessment:true,units});assert.equal(receipt.decision,'accept');
});
await test('Partial memory coverage stays explicit even when no search was called in this turn',()=>{
 for(const data of [{input:[]},{input:[],history:[{id:'partial',role:'user',text:'合成爱好。'}],conversationSummary:{sections:{topics:[]}}}]){
  const packet=JSON.parse(reviewMessages(data,'这项细节还不清楚。')[1].content[0].text);
  assert.equal(packet.recalledContext.coverage.completeHistory,false);assert.equal(packet.recalledContext.coverage.absenceIsProof,false);assert.equal(packet.currentExecution.completedMemorySearch,false);
 }
});
await test('Image follow-up availability is explicit without replaying old attachments',f=>{
 const input=f.owner('再看一下那张图。'),data={input:[input],persona:f.persona(),history:[{id:'old-image',role:'user',text:'历史图片',content:[{type:'image',attachment:{id:'old'}}]}]};
 const assembled=contextMessages(f.agent,'foreground','test',data),packet=JSON.parse(assembled[1].content[0].text),review=JSON.parse(reviewMessages(data,'请把图再发一下。')[1].content[0].text);
 assert.equal(packet.imageInputContext.currentImageCount,0);assert.equal(packet.imageInputContext.historicalImagesReplayed,false);assert.deepEqual(packet.imageInputContext,review.imageInputContext);
 assert.equal(imageContentCount(assembled),0);
 const withImage={...data,input:[{...input,content:[...input.content,{type:'image',attachment:{id:'new'}}]}]};
 assert.equal(JSON.parse(reviewMessages(withImage,'收到图了。')[1].content[0].text).imageInputContext.currentImageCount,1);
});
await test('One built-in foreground voice guide preserves custom skills and legacy fallback',async f=>{
 f.journal.transaction=fn=>fn();const skills=new SkillStore(f.journal);
 await skills.save(f.id,{name:'custom-voice',content:'用户自己的表达约定',sourceType:'manual',loadMode:'compact',scopes:['foreground']});
 let prompt=skills.prompt(f.id,'foreground','你好');assert(prompt.includes('<skill name="human-dialogue"'));assert(!prompt.includes('<skill name="zhiqiu-expression"'));assert(prompt.includes('用户自己的表达约定'));assert(!prompt.includes('<skill name="humanizer"'));
 assert(skills.prompt(f.id,'foreground','humanizer').includes('<skill name="humanizer"'));assert(skills.prompt(f.id,'chat').includes('<skill name="zhiqiu-expression"'));
 skills.toggle(f.id,'human-dialogue',false,skills.get(f.id,'human-dialogue').version);prompt=skills.prompt(f.id,'foreground');assert(!prompt.includes('<skill name="human-dialogue"'));assert(prompt.includes('<skill name="zhiqiu-expression"'));assert(prompt.includes('用户自己的表达约定'));
});
const report={at:new Date().toISOString(),passed:tests.filter(t=>t.passed).length,failed:tests.filter(t=>!t.passed).length,cases:tests,scope:'Synthetic stores and model protocols; no production, actual model, IM or restart.'};console.log(serialize(report));if(report.failed)process.exitCode=1;
