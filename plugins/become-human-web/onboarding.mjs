import fs from 'node:fs/promises';
import path from 'node:path';
import {readSourceModelConfiguration} from './supervisor.mjs';
import {getPresetConfig} from './runtime/preset-config.mjs';

const fail=code=>{throw new Error(code);};
const profileName=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]+$/.test(value);
const codeOf=error=>/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'SETUP_FAILED';
const exists=async file=>{try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function cliProfile(){
 const args=process.argv.slice(2),index=args.indexOf('--profile');
 if(index>=0&&profileName(args[index+1]))return args[index+1];
 const named=args.find(arg=>arg.startsWith('--profile='));if(named&&profileName(named.slice(10)))return named.slice(10);
 return 'web';
}
function currentOffset(timeZone){
 try{
  const now=new Date(),formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const parts=Object.fromEntries(formatter.formatToParts(now).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  const offset=Math.round((Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second)-Math.floor(now.getTime()/1000)*1000)/60000);
  if(!Number.isInteger(offset)||offset < -720||offset > 840)fail('INVALID_SETUP_TIMEZONE');return offset;
 }catch{fail('INVALID_SETUP_TIMEZONE');}
}
function validatedInput(input){
 const allowed=['op','sessionId','requestId','expectedRevision','provider','model','personaPreset','budgetPreset','ownerName','timeZone','startAutonomy'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))fail('INVALID_SETUP_REQUEST');
 if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.requestId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)fail('INVALID_SETUP_REQUEST');
 for(const key of ['provider','model'])if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>256)fail('INVALID_SETUP_REQUEST');
 if(typeof input.personaPreset!=='string'||typeof input.budgetPreset!=='string'||typeof input.ownerName!=='string'||input.ownerName.length>80||typeof input.timeZone!=='string'||input.timeZone.length>100||typeof input.startAutonomy!=='boolean')fail('INVALID_SETUP_REQUEST');
 currentOffset(input.timeZone);
 return {requestId:input.requestId,provider:input.provider,model:input.model,personaPreset:input.personaPreset,budgetPreset:input.budgetPreset,ownerName:input.ownerName.trim(),timeZone:input.timeZone,startAutonomy:input.startAutonomy};
}

/** First-run state belongs to the manager, never to the user's profile patch. */
export class HumanOnboarding {
 static async create({root,config={},profileContext,runtimeVersion}){
  const instance=new HumanOnboarding(root,runtimeVersion),filename=instance.filename;
  let stored=null;
  try{
   const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)fail('SETUP_STATE_INVALID');
   stored=JSON.parse(await fs.readFile(filename,'utf8'));
   if(stored?.schema!==1||!['welcome','creating','failed','complete'].includes(stored.phase)||!Number.isSafeInteger(stored.revision)||stored.revision<1)fail('SETUP_STATE_INVALID');
   if(stored.phase==='welcome'){if(stored.input!==null||stored.sessionId!==undefined)fail('SETUP_STATE_INVALID');}
   else stored.input=validatedInput({...stored.input,expectedRevision:stored.revision});
   if(stored.sessionId!==undefined&&(typeof stored.sessionId!=='string'||stored.sessionId.length>128))fail('SETUP_STATE_INVALID');
   if(!stored.steps||typeof stored.steps!=='object'||Array.isArray(stored.steps)||Object.keys(stored.steps).some(key=>!['persona','autonomy'].includes(key)||typeof stored.steps[key]!=='boolean'))fail('SETUP_STATE_INVALID');
  }catch(error){if(error.code!=='ENOENT'){instance.loadError='SETUP_STATE_INVALID';stored=null;}}
  const sourceHome=config.sourceHome??profileContext?.home??process.env.DSH_HOME;
  const sourceProfile=config.sourceProfile??profileContext?.name??cliProfile();
  instance.config={...config,sourceHome,sourceProfile,runtimeHome:config.runtimeHome??path.join(root,'runtime-home'),runtimeProfile:config.runtimeProfile??'become-human-runtime',provider:config.provider??stored?.input?.provider,model:config.model??stored?.input?.model};
  instance.originalSelection={provider:config.provider,model:config.model};
  instance.saved=stored;
  const identityFile=path.join(instance.config.runtimeHome,'become-human/agent.json');let identity=null,identityPresent=false;
  try{
   const stat=await fs.lstat(identityFile);identityPresent=true;if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)fail('SETUP_SESSION_INVALID');
   identity=JSON.parse(await fs.readFile(identityFile,'utf8'));if(typeof identity?.sessionId!=='string'||!/^[a-zA-Z0-9._:-]{1,128}$/.test(identity.sessionId))fail('SETUP_SESSION_INVALID');
  }catch(error){if(error.code!=='ENOENT')instance.loadError??='SETUP_SESSION_INVALID';}
  if(stored?.sessionId&&!identityPresent)instance.loadError??='SETUP_SESSION_MISSING';
  if(stored?.phase!=='complete'&&stored?.sessionId&&identity?.sessionId!==stored.sessionId)instance.loadError??='SETUP_SESSION_CHANGED';
  // Completed setup is not an eternal lock on the initial ID: managed deletion
  // can replace it. The worker validates its signed retirement ledger on boot.
  instance.existing=identityPresent||!!(config.provider&&config.model);
  if(identityPresent&&(!instance.config.provider||!instance.config.model)){
   try{
    const selection=JSON.parse(await fs.readFile(path.join(instance.config.runtimeHome,'runtime-selection.json'),'utf8'));
    if(typeof selection.provider!=='string'||!selection.provider||selection.provider.length>256||typeof selection.model!=='string'||!selection.model||selection.model.length>256)fail('MODEL_SELECTION_MISSING');
    instance.config.provider??=selection.provider;instance.config.model??=selection.model;
   }catch{instance.loadError??='MODEL_SELECTION_MISSING';}
  }
  instance.legacy=instance.existing&&!stored;
  if(instance.loadError&&instance.existing)instance.legacy=true;
  if(stored?.phase==='creating'&&!instance.loadError)await instance.persist({...stored,phase:'failed',error:'SETUP_INTERRUPTED'});
  await instance.refresh();return instance;
 }
 constructor(root,runtimeVersion){this.root=root;this.filename=path.join(root,'setup.json');this.runtimeVersion=runtimeVersion;this.saved=null;this.error=null;this.models=[];this.defaultRoute=null;this.issues=[];this.resettable=false;}
 attach(runtime,control){this.runtime=runtime;this.controlRuntime=control;}
 get required(){return !this.legacy&&this.saved?.phase!=='complete';}
 get supported(){return !this.loadError&&process.platform==='win32'&&Number(process.versions.node.split('.')[0])>=24&&this.runtimeVersion==='0.2.0-rc.2'&&this.issues.every(issue=>!['INVALID_SETUP_PATHS','INVALID_SETUP_PROFILE'].includes(issue.code));}
 async refresh(){
  const issues=[];
  if(process.platform!=='win32')issues.push({code:'UNSUPPORTED_KEY_PLATFORM',message:'当前完整运行模块需要 Windows。'});
  if(Number(process.versions.node.split('.')[0])<24)issues.push({code:'UNSUPPORTED_NODE_VERSION',message:'请使用 Node.js 24 或以上版本启动 DSH。'});
  if(this.runtimeVersion!=='0.2.0-rc.2')issues.push({code:'UNSUPPORTED_DSH_VERSION',message:'当前版本仅适配 DSH 0.2.0-rc.2。'});
  const c=this.config;
  if(!path.isAbsolute(c.sourceHome??'')||!path.isAbsolute(c.runtimeHome??'')||path.resolve(c.sourceHome)===path.resolve(c.runtimeHome))issues.push({code:'INVALID_SETUP_PATHS',message:'运行目录配置无效，请检查已有高级配置。'});
  if(!profileName(c.sourceProfile)||!profileName(c.runtimeProfile))issues.push({code:'INVALID_SETUP_PROFILE',message:'当前 profile 名称不符合运行模块要求。'});
  try{
   const source=await readSourceModelConfiguration(c);this.models=source.models;this.defaultRoute=source.defaultRoute;
   if(!this.models.length)issues.push({code:'MODEL_ROUTE_REQUIRES_SETUP',message:'请先在 DSH 模型设置中添加使用凭据引用的 llm-pi-ai 模型，然后刷新。'});
   else if(!this.models.some(model=>model.credentialReady))issues.push({code:'MODEL_CREDENTIAL_MISSING',message:'已发现模型，但凭据引用尚不可用。请在 DSH 中完成凭据设置后刷新。'});
  }catch(error){this.models=[];this.defaultRoute=null;issues.push({code:codeOf(error),message:'暂时无法读取当前 DSH profile 的模型配置，请完成 DSH 模型设置后刷新。'});}
  if(this.loadError)issues.push({code:this.loadError,message:({SETUP_SESSION_MISSING:'现有会话标识文件缺失，已停止启动以免创建另一会话。请检查数据或恢复备份。',SETUP_SESSION_INVALID:'现有会话标识无法读取，已停止启动。请检查数据或恢复备份。',SETUP_SESSION_CHANGED:'未完成的设置对应会话已变化，已停止继续写入。请检查运行诊断。',MODEL_SELECTION_MISSING:'已找到原会话，但无法恢复它原来的模型选择。请补全已有高级模型配置后重启。'})[this.loadError]??'首次设置记录无法读取。现有会话不会被覆盖，请检查数据与运行诊断。'});
  this.issues=issues;this.resettable=await this.canReset();return this.describe();
 }
 describe(){
  const saved=this.saved,phase=this.legacy?'legacy':saved?.phase??(this.error?'failed':'welcome');
  return {required:this.required,phase,revision:saved?.revision??1,models:this.models,defaultRoute:this.defaultRoute,environment:{supported:this.supported,node:process.versions.node,dsh:this.runtimeVersion,sourceProfile:this.config.sourceProfile,issues:this.issues},error:this.loadError??saved?.error??this.error??null,existing:this.existing,canReset:this.resettable,...(saved?.input&&saved.phase!=='complete'?{pending:{...saved.input}}:{})};
 }
 async canReset(){try{return !this.loadError&&this.required&&this.saved?.phase==='failed'&&!this.saved.sessionId&&!this.runtime?.waiting&&!(this.runtime?.child&&this.runtime.child.exitCode===null&&this.runtime.child.signalCode===null)&&!await exists(path.join(this.config.runtimeHome,'become-human'));}catch{return false;}}
 async reset(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['op','sessionId','requestId','expectedRevision'].includes(key)))fail('INVALID_SETUP_REQUEST');
  if(input.expectedRevision!==(this.saved?.revision??1))fail('STALE_SETUP');
  if(input.requestId!==this.saved?.input?.requestId||!await this.canReset())fail('SETUP_RESET_NOT_ALLOWED');
  await this.persist({phase:'welcome',input:null,steps:{},error:null});
  this.error=null;this.resettable=false;Object.assign(this.config,this.originalSelection);if(this.runtime)Object.assign(this.runtime.config,this.originalSelection);await this.refresh();
 }
 async persist(next){
  const record={...next,schema:1,revision:(this.saved?.revision??1)+1,updatedAt:Date.now()},temporary=this.filename+'.'+crypto.randomUUID()+'.tmp';
  try{const stat=await fs.lstat(this.filename);if(!stat.isFile()||stat.isSymbolicLink())fail('SETUP_STATE_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{await fs.writeFile(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,this.filename);}catch(error){await fs.unlink(temporary).catch(()=>{});throw error;}
  this.saved=record;return record;
 }
 async complete(input){
  const selection=validatedInput(input);
  if(this.legacy||this.loadError)fail(this.loadError??'SETUP_ALREADY_COMPLETE');
  if(this.saved?.input){
   if(this.saved.input.requestId!==selection.requestId||JSON.stringify(this.saved.input)!==JSON.stringify(selection))fail('SETUP_REQUEST_CONFLICT');
   if(this.saved.phase==='complete')return;
  }
  if(input.expectedRevision!==(this.saved?.revision??1))fail('STALE_SETUP');
  await this.refresh();if(!this.supported)fail('SETUP_ENVIRONMENT_UNSUPPORTED');
  const route=this.models.find(model=>model.provider===selection.provider&&model.model===selection.model);
  if(!route)fail('MODEL_ROUTE_NOT_ALLOWED');if(!route.credentialReady)fail('MODEL_CREDENTIAL_MISSING');
  const personaCatalog=JSON.parse(await fs.readFile(new URL('./runtime/presets/personas.json',import.meta.url),'utf8'));
  const budgetCatalog=JSON.parse(await fs.readFile(new URL('./runtime/presets/autonomy-budgets.json',import.meta.url),'utf8'));
  const persona=getPresetConfig(personaCatalog,selection.personaPreset,'persona'),budget=getPresetConfig(budgetCatalog,selection.budgetPreset,'autonomy-budget');
  if(!this.saved&&await exists(path.join(this.config.runtimeHome,'become-human/agent.json')))fail('SETUP_EXISTING_SESSION');
  await this.persist({...this.saved,input:selection,steps:this.saved?.steps??{},phase:'creating',error:null});
  Object.assign(this.config,{provider:selection.provider,model:selection.model});Object.assign(this.runtime.config,{provider:selection.provider,model:selection.model});
  try{
   let state;
   if(this.runtime.cookie&&this.runtime.child?.exitCode===null)state=await this.runtime.state();else{this.runtime.closed=false;await this.runtime.start();state=await this.runtime.state();}
   if(!state.sessionId||state.retiring)fail('SETUP_RUNTIME_NOT_READY');
   if(this.saved.sessionId&&this.saved.sessionId!==state.sessionId)fail('SETUP_SESSION_CHANGED');
   if(state.desired!=='paused'||state.agentBusy)fail('SETUP_PAUSE_REQUIRED');
   await this.persist({...this.saved,sessionId:state.sessionId});
   if(!this.saved.steps.persona){
    const profile={...state.management.profile,...persona,ownerName:selection.ownerName};
    if(Object.keys(profile).some(key=>profile[key]!==state.management.profile[key]))await this.runtime.control({op:'profile-save',sessionId:state.sessionId,expectedRevision:state.management.revision,profile});
    await this.persist({...this.saved,steps:{...this.saved.steps,persona:true}});state=await this.runtime.state();
   }
   if(!this.saved.steps.autonomy){
    const settings={...budget,timeZoneOffsetMinutes:currentOffset(selection.timeZone),enabled:selection.startAutonomy,learningEnabled:selection.startAutonomy,proactiveEnabled:selection.startAutonomy,socialEnabled:selection.startAutonomy,searchEnabled:selection.startAutonomy,wakeIntervalMs:this.config.intervalMs};
    if(Object.keys(settings).some(key=>settings[key]!==state.autonomy.settings[key]))await this.runtime.control({op:'autonomy-configure',sessionId:state.sessionId,expectedRevision:state.management.revision,settings});
    await this.persist({...this.saved,steps:{...this.saved.steps,autonomy:true}});state=await this.runtime.state();
   }
   // Mark the configuration durable before starting any user-authorized work.
   // Subsequent launches never replay presets, owner data, or this start action.
   await this.persist({...this.saved,phase:'complete',completedAt:Date.now(),error:null});
   await this.controlRuntime({op:'start',sessionId:state.sessionId,expectedEpoch:state.cancelEpoch});
   this.runtime.recordLifecycle('onboarding-complete',{sessionId:state.sessionId,autonomy:selection.startAutonomy});
  }catch(error){
   const code=codeOf(error);this.error=code;
   const failed={...this.saved,...(this.saved?.phase!=='complete'?{phase:'failed'}:{}),error:code};
   try{await this.persist(failed);}catch{this.saved=failed;this.error='SETUP_STATE_WRITE_FAILED';}
   this.resettable=await this.canReset();
   throw error;
  }
 }
}
