import assert from 'node:assert/strict';
import {modelFailureDiagnostic,safeProviderMessage,saveModelFailure,clearModelFailure} from '../plugins/become-human/model-failure.mjs';
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
 ['context',{message:'maximum context length exceeded'},'context'],
 ['timeout',{message:'connection timed out'},'timeout'],
 ['network',{message:'fetch failed'},'network'],
 ['missing upstream evidence',{},'unknown']
])check(name,()=>assert.equal(modelFailureDiagnostic(failure).category,category));
check('empty and validation are distinct',()=>{assert.equal(modelFailureDiagnostic({},'EMPTY_MODEL_OUTPUT').category,'empty');assert.equal(modelFailureDiagnostic({},'INVALID_TASK_OUTPUT').category,'validation');});
check('secrets paths and URLs removed',()=>{const text=safeProviderMessage('Model unavailable sk-abcdefghijklmnop authorization: Bearer-secret api_key="credential123" https://host.test/?token=abc C:\\Users\\private\\config');for(const value of ['abcdefghijklmnop','Bearer-secret','credential123','host.test','private'])assert(!text.includes(value));});
check('request dumps hidden',()=>assert(!safeProviderMessage('HTTP error messages: [{secret conversation}]').includes('conversation')));
check('JSON keeps only error message',()=>assert.equal(safeProviderMessage(JSON.stringify({error:{message:'Model no longer available'},request:{messages:['private conversation']}})),'Model no longer available'));
check('unknown codes and invalid statuses not exposed',()=>{const d=modelFailureDiagnostic({code:'SUPPLIER_PRIVATE_CODE',status:900});assert.equal(d.upstreamCode,undefined);assert.equal(d.httpStatus,undefined);});
const values=new Map(),j={value:(_,key,fallback)=>values.get(key)??fallback,put:(_,key,value)=>values.set(key,value)};
check('one successful lane cannot hide another lane failure',()=>{saveModelFailure(j,'same',{lane:'selection',code:'MODEL_EXECUTION_FAILED',at:10});saveModelFailure(j,'same',{lane:'foreground',code:'EMPTY_MODEL_OUTPUT',at:20});clearModelFailure(j,'same','foreground');assert(values.get('modelFailures').selection);assert(!values.get('modelFailures').foreground);});
check('active error shown and resolved error hidden',()=>{const s={autonomy:{paused:true,error:'MODEL_EXECUTION_FAILED'},modelFailures:values.get('modelFailures')};assert.equal(activeModelAlerts(s).length,1);assert.equal(activeModelAlerts({...s,autonomy:{paused:false,error:null}}).length,0);});
check('old records keep evidence limits',()=>{const [d]=activeModelAlerts({autonomy:{paused:true,error:'MODEL_EXECUTION_FAILED'},attempts:[{id:'old',trigger:'autonomous-tick',error:'MODEL_EXECUTION_FAILED',config:'{"provider":"old-provider","model":"old-model"}',failure_facts:'{"streamFinish":"error"}',ended:123}]});assert.equal(d.category,'unknown');assert.equal(d.legacy,true);assert.equal(d.model,'old-model');assert.equal(d.at,123);});
console.log(JSON.stringify({passed:cases.length,cases,scope:'synthetic errors and actual diagnostic functions; no provider requests'}));
