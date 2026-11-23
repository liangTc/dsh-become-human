import assert from 'node:assert/strict';
import {modelFailureDiagnostic,safeProviderMessage,saveModelFailure,clearModelFailure,modelFailureNotification,transientModelFailure} from '../plugins/become-human/model-failure.mjs';
import {activeModelAlerts} from '../plugins/become-human-web/model-alerts.mjs';
const cases=[];function check(name,fn){fn();cases.push(name);}
for(const [name,failure,category]of [
 ['model retirement',{message:'This model has been deprecated.'},'model-retired'],
 ['missing model is ambiguous',{message:'Model demo does not exist or you have no access'},'model-unavailable'],
 ['404 is not proof of retirement',{status:404},'not-found'],
 ['expired key is not retired model',{message:'API token expired',status:401},'authentication'],
 ['balance',{message:'Insufficient balance',status:402},'provider-quota'],
 ['rate limit',{status:429},'rate-limit'],
 ['permission',{status:403},'permission'],
 ['provider outage',{status:503},'provider-unavailable'],
 ['adapter reports upstream outage only in its error string',{message:'502 status code (no body)'},'provider-unavailable'],
 ['context',{message:'maximum context length exceeded'},'context'],
 ['timeout',{message:'connection timed out'},'timeout'],
 ['network',{message:'fetch failed'},'network'],
 ['incomplete stream',{message:'Stream ended without finish_reason'},'incomplete-stream'],
 ['missing upstream evidence',{},'unknown']
])check(name,()=>assert.equal(modelFailureDiagnostic(failure).category,category));
check('only whole no-body adapter diagnostics supply a missing HTTP status',()=>{
 const outage=modelFailureDiagnostic({message:'502 status code (no body)'});
 assert.equal(outage.httpStatus,502);assert.equal(transientModelFailure(outage),true);
 const denied=modelFailureDiagnostic({status:403,message:'502 status code (no body)'});
 assert.equal(denied.httpStatus,403);assert.equal(transientModelFailure(denied),false);
 assert.equal(modelFailureDiagnostic({message:'A conversation mentioned 502 status code (no body)'}).httpStatus,undefined);
});
check('empty and validation are distinct',()=>{assert.equal(modelFailureDiagnostic({},'EMPTY_MODEL_OUTPUT').category,'empty');assert.equal(modelFailureDiagnostic({},'INVALID_TASK_OUTPUT').category,'validation');});
check('secrets paths and URLs removed',()=>{const text=safeProviderMessage('Model unavailable sk-abcdefghijklmnop authorization: Bearer-secret api_key="credential123" https://host.test/?token=abc C:\\Users\\private\\config');for(const value of ['abcdefghijklmnop','Bearer-secret','credential123','host.test','private'])assert(!text.includes(value));});
check('request dumps hidden',()=>assert(!safeProviderMessage('HTTP error messages: [{secret conversation}]').includes('conversation')));
check('JSON keeps only error message',()=>assert.equal(safeProviderMessage(JSON.stringify({error:{message:'Model no longer available'},request:{messages:['private conversation']}})),'Model no longer available'));
check('unknown codes and invalid statuses not exposed',()=>{const d=modelFailureDiagnostic({code:'SUPPLIER_PRIVATE_CODE',status:900});assert.equal(d.upstreamCode,undefined);assert.equal(d.httpStatus,undefined);});
const values=new Map(),j={value:(_,key,fallback)=>values.get(key)??fallback,put:(_,key,value)=>values.set(key,value)};
check('receipts describe observed stream output and omit local error echoes',()=>{
 const local='EMPTY_MODEL_OUTPUT';
 const notice=facts=>modelFailureNotification({lane:'selection',code:local,at:1,...modelFailureDiagnostic(Error(local),local,facts),...facts});
 assert.match(notice({textChars:0,reasoningChars:10}),/收到.*推理/);
 assert.match(notice({textChars:2,reasoningChars:0}),/空白/);
 assert.doesNotMatch(notice({textChars:0}),/只.*推理|说明：EMPTY_MODEL_OUTPUT/);
});
check('recoverable selection failures coalesce until recovery, route change or next hourly notice',()=>{
 const state={},sent=[],journal={value:(_id,key,fallback)=>state[key]??fallback,put:(_id,key,val)=>{state[key]=val;},publish:(_id,_msg,_kind,identity)=>sent.push(identity)};
 const report=(attemptId,at,patch={})=>saveModelFailure(journal,'human',{provider:'p',model:'m',purpose:null,lane:'selection',code:'EMPTY_MODEL_OUTPUT',category:'empty',attemptId,at,...patch});
 report('a',10);report('b',25);report('c',3599999);
 assert.equal(state.modelFailures.selection.attemptId,'c');assert.deepEqual(sent,['model-error:a']);
 report('d',3600010);report('e',3600015,{model:'different'});clearModelFailure(journal,'human','selection');report('f',3600017,{model:'different'});
 report('g',3600020,{lane:'foreground'});report('h',3600021,{lane:'foreground'});
 assert.deepEqual(sent,['a','d','e','f','g','h'].map(id=>'model-error:'+id));
 assert(transientModelFailure({code:'EMPTY_MODEL_OUTPUT'}));
 assert(transientModelFailure({code:'MODEL_EXECUTION_FAILED',category:'incomplete-stream'}));
 assert(!transientModelFailure({code:'EMPTY_MODEL_OUTPUT',httpStatus:401}));
 assert(!transientModelFailure({code:'MODEL_EXECUTION_FAILED',category:'unknown'}));
});
check('one successful lane cannot hide another lane failure',()=>{saveModelFailure(j,'same',{lane:'selection',code:'MODEL_EXECUTION_FAILED',at:10});saveModelFailure(j,'same',{lane:'foreground',code:'EMPTY_MODEL_OUTPUT',at:20});clearModelFailure(j,'same','foreground');assert(values.get('modelFailures').selection);assert(!values.get('modelFailures').foreground);});
check('active error shown and resolved error hidden',()=>{const s={autonomy:{paused:true,error:'MODEL_EXECUTION_FAILED'},modelFailures:values.get('modelFailures')};assert.equal(activeModelAlerts(s).length,1);assert.equal(activeModelAlerts({...s,autonomy:{paused:false,error:null}}).length,0);});
check('a foreground failure on a running worker keeps chat available in the alert',()=>{
 const s={desired:'running',lastError:'EMPTY_MODEL_OUTPUT',autonomy:{paused:false},modelFailures:{foreground:{code:'EMPTY_MODEL_OUTPUT',lane:'foreground',category:'empty',reasoningChars:5}}};
 const [alert]=activeModelAlerts(s);assert.equal(alert.scope,'foreground');assert.equal(alert.chatAvailable,true);
 assert.match(alert.summary,/推理/);assert.equal(activeModelAlerts({...s,desired:'paused'})[0].chatAvailable,false);
});
check('old records keep evidence limits',()=>{const [d]=activeModelAlerts({autonomy:{paused:true,error:'MODEL_EXECUTION_FAILED'},attempts:[{id:'old',trigger:'autonomous-tick',error:'MODEL_EXECUTION_FAILED',config:'{"provider":"old-provider","model":"old-model"}',failure_facts:'{"streamFinish":"error"}',ended:123}]});assert.equal(d.category,'unknown');assert.equal(d.legacy,true);assert.equal(d.model,'old-model');assert.equal(d.at,123);});
check('old saved stream error includes review stage without rewriting evidence',()=>{const entry={attemptId:'old-review',lane:'foreground',code:'MODEL_EXECUTION_FAILED',category:'unknown',upstreamMessage:'Stream ended without finish_reason'},s={lastError:entry.code,modelFailures:{foreground:entry},attempts:[{id:'old-review',purpose:'conversation-review'}]};const [d]=activeModelAlerts(s);assert.equal(d.category,'incomplete-stream');assert.match(d.summary,/回复检查/);assert.equal(entry.category,'unknown');});
console.log(JSON.stringify({passed:cases.length,cases,scope:'synthetic errors and actual diagnostic functions; no provider requests'}));
