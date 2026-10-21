import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {PUBLIC_MCP_PROTOCOL,PUBLIC_MCP_TOOL,PUBLIC_MCP_SCHEMA,publicMcpInput} from './bundled-public-mcp.mjs';

const MAX_REQUEST=16384,MAX_MESSAGE=32768,MAX_TOOL_RESULT=16384;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const fail=code=>{throw new Error(code);};
const coded=(error,fallback)=>/^[A-Z_]{3,80}$/.test(error?.message??'')?error.message:fallback;
const serverPath=fileURLToPath(new URL('./bundled-public-mcp.mjs',import.meta.url));

// The fixed bundled executable is the trust boundary. In particular, remote
// readOnlyHint annotations cannot grant access to commands or additional tools.
function childEnvironment(){
  const allowed=new Set(['SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','LANG','LC_ALL']);
  return Object.fromEntries(Object.entries(process.env).filter(([key,value])=>allowed.has(key.toUpperCase())&&typeof value==='string'));
}

export class ReadOnlyMcpProvider {
  constructor({timeoutMs=25000}={}){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)fail('INVALID_MCP_TIMEOUT');
    this.timeoutMs=timeoutMs;this.child=null;this.ready=false;this.closed=false;this.pending=new Map();this.terminating=new Map();this.counter=0;this.buffer=Buffer.alloc(0);this.busy=false;this.lastError=null;this.startedAt=null;this.connecting=null;
  }
  status(){return {backend:'mcp-stdio',server:'bundled-public',protocolVersion:PUBLIC_MCP_PROTOCOL,tool:PUBLIC_MCP_TOOL,readOnly:true,connected:this.ready&&!!this.child,running:!!this.child,terminating:this.terminating.size,pending:this.pending.size,closed:this.closed,lastError:this.lastError,startedAt:this.startedAt};}
  async start(signal){
    signal?.throwIfAborted();if(this.closed)fail('MCP_PROVIDER_CLOSED');if(this.ready&&this.child)return;if(this.connecting)return this.connecting;
    const promise=this.connect(signal);this.connecting=promise;
    try{await promise;}finally{if(this.connecting===promise)this.connecting=null;}
  }
  async connect(signal){
    // A cancellation is not acknowledged merely because kill() returned. A new
    // process cannot start while the old process might still be fetching.
    await this.waitForExit(signal);signal?.throwIfAborted();if(this.closed)fail('MCP_PROVIDER_CLOSED');
    const child=spawn(process.execPath,[serverPath],{cwd:dirname(serverPath),env:childEnvironment(),stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    this.child=child;this.ready=false;this.buffer=Buffer.alloc(0);this.startedAt=Date.now();
    child.stdout.on('data',chunk=>this.consume(child,chunk));
    child.stderr.on('data',()=>{}); // Bounded draining; never log page data or credentials.
    child.on('error',()=>this.disconnect(child,'MCP_PROCESS_FAILED'));
    child.on('exit',()=>this.disconnect(child,'MCP_PROCESS_EXITED'));
    child.stdin.on('error',()=>this.disconnect(child,'MCP_STDIN_FAILED'));
    child.stdout.on('error',()=>this.disconnect(child,'MCP_STDOUT_FAILED'));
    try{
      const initialized=await this.request('initialize',{protocolVersion:PUBLIC_MCP_PROTOCOL,capabilities:{},clientInfo:{name:'become-human-capabilities',version:'1.0.0'}},signal);
      if(!object(initialized)||initialized.protocolVersion!==PUBLIC_MCP_PROTOCOL||!object(initialized.capabilities?.tools))fail('MCP_INITIALIZE_REJECTED');
      this.notify('notifications/initialized',{});
      const listing=await this.request('tools/list',{},signal);
      const tool=Array.isArray(listing?.tools)&&listing.tools.find(value=>value?.name===PUBLIC_MCP_TOOL);
      if(!tool||JSON.stringify(tool.inputSchema)!==JSON.stringify(PUBLIC_MCP_SCHEMA))fail('MCP_TOOL_SCHEMA_MISMATCH');
      signal?.throwIfAborted();if(this.child!==child)fail('MCP_PROCESS_EXITED');this.ready=true;this.lastError=null;
    }catch(error){this.disconnect(child,coded(error,'MCP_CONNECT_FAILED'));throw error;}
  }
  write(message){
    if(!this.child||this.closed)fail('MCP_NOT_CONNECTED');
    const encoded=JSON.stringify(message)+'\n';if(Buffer.byteLength(encoded)>MAX_REQUEST)fail('MCP_REQUEST_TOO_LARGE');
    this.child.stdin.write(encoded);
  }
  notify(method,params){this.write({jsonrpc:'2.0',method,params});}
  request(method,params,signal){
    signal?.throwIfAborted();if(this.closed)fail('MCP_PROVIDER_CLOSED');
    if(this.pending.size>=2)fail('MCP_TOO_MANY_REQUESTS');
    const id=++this.counter,child=this.child;
    return new Promise((resolve,reject)=>{
      const finish=(error,result)=>{
        const task=this.pending.get(id);if(!task)return;
        this.pending.delete(id);clearTimeout(task.timer);signal?.removeEventListener('abort',task.abort);
        error?reject(error):resolve(result);
      };
      const abort=()=>{
        try{this.notify('notifications/cancelled',{requestId:id,reason:'Owner cancelled task'});}catch{}
        finish(signal?.reason??new Error('MCP_REQUEST_CANCELLED'));
        // The server honours cancellation; kill also bounds shutdown if it fails.
        this.disconnect(child,'MCP_REQUEST_CANCELLED');
      };
      const timer=setTimeout(()=>{
        try{this.notify('notifications/cancelled',{requestId:id,reason:'Request timed out'});}catch{}
        finish(new Error('MCP_REQUEST_TIMEOUT'));this.disconnect(child,'MCP_REQUEST_TIMEOUT');
      },this.timeoutMs);
      this.pending.set(id,{finish,timer,abort});signal?.addEventListener('abort',abort,{once:true});
      try{this.write({jsonrpc:'2.0',id,method,params});if(signal?.aborted)abort();}catch(error){finish(error);this.disconnect(child,coded(error,'MCP_WRITE_FAILED'));}
    });
  }
  consume(child,chunk){
    if(child!==this.child)return;
    let start=0;
    for(let index=0;index<chunk.length;index++){
      if(chunk[index]!==10)continue;
      const part=chunk.subarray(start,index);start=index+1;
      if(this.buffer.length+part.length>MAX_MESSAGE){this.disconnect(child,'MCP_RESPONSE_TOO_LARGE');return;}
      const line=Buffer.concat([this.buffer,part]);this.buffer=Buffer.alloc(0);
      if(!line.toString('utf8').trim())continue;
      let message;try{message=JSON.parse(line.toString('utf8'));}catch{this.disconnect(child,'MCP_INVALID_JSON');return;}
      if(!object(message)||message.jsonrpc!=='2.0'){this.disconnect(child,'MCP_INVALID_RESPONSE');return;}
      if(typeof message.method==='string'){
        // The client advertises no sampling, elicitation, roots, or other
        // facilities. An MCP server may never delegate an action to the model.
        if(own(message,'id')){try{this.write({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client method not supported'}});}catch{this.disconnect(child,'MCP_INVALID_RESPONSE');return;}}
        continue;
      }
      const task=this.pending.get(message.id);
      if(!task){this.disconnect(child,'MCP_UNEXPECTED_RESPONSE');return;}
      if(own(message,'error')===own(message,'result')){this.disconnect(child,'MCP_INVALID_RESPONSE');return;}
      if(own(message,'error'))task.finish(new Error(/^[-\w]{1,80}$/.test(message.error?.message??'')?message.error.message:'MCP_PROTOCOL_ERROR'));
      else task.finish(null,message.result);
    }
    const tail=chunk.subarray(start);
    if(this.buffer.length+tail.length>MAX_MESSAGE){this.disconnect(child,'MCP_RESPONSE_TOO_LARGE');return;}
    this.buffer=Buffer.concat([this.buffer,tail]);
  }
  disconnect(child,code){
    if(!child||child!==this.child)return;
    this.child=null;this.ready=false;this.buffer=Buffer.alloc(0);this.lastError=code;
    for(const task of [...this.pending.values()])task.finish(new Error(code));
    if(child.exitCode===null&&child.signalCode===null){
      let acknowledge;
      const exited=new Promise(resolve=>{acknowledge=()=>{this.terminating.delete(child);child.removeListener('exit',acknowledge);child.removeListener('close',acknowledge);resolve();};});
      this.terminating.set(child,exited);child.once('exit',acknowledge);child.once('close',acknowledge);
    }
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
    try{child.kill('SIGKILL');}catch{}
  }
  async waitForExit(signal){
    signal?.throwIfAborted();if(!this.terminating.size)return;
    await new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>finish(signal.reason??new Error('MCP_REQUEST_CANCELLED'));
      const timer=setTimeout(()=>{this.lastError='MCP_PROCESS_EXIT_UNCONFIRMED';finish(new Error('MCP_PROCESS_EXIT_UNCONFIRMED'));},2000);
      signal?.addEventListener('abort',abort,{once:true});
      Promise.all([...this.terminating.values()]).then(()=>finish());if(signal?.aborted)abort();
    });
  }
  async readPage(input,{signal}={}){
    const args=publicMcpInput(input);signal?.throwIfAborted();if(this.busy)fail('MCP_PUBLIC_BUSY');this.busy=true;
    const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs);
    try{
      await this.start(deadline);
      const response=await this.request('tools/call',{name:PUBLIC_MCP_TOOL,arguments:args},deadline);deadline.throwIfAborted();
      if(!object(response)||!Array.isArray(response.content))fail('MCP_INVALID_TOOL_RESULT');
      if(response.isError){const text=response.content.find(item=>item?.type==='text')?.text;fail(/^[A-Z_]{3,80}$/.test(text??'')?text:'MCP_PUBLIC_READ_FAILED');}
      const page=response.structuredContent;
      if(!object(page)||typeof page.url!=='string'||typeof page.title!=='string'||typeof page.excerpt!=='string'||page.excerpt.length>2800||!/^[0-9a-f]{64}$/.test(page.digest??'')||!Number.isFinite(page.fetchedAt)||page.evidenceStatus!=='read-not-verified'||page.semanticVerified!==false||page.untrusted!==true)fail('MCP_INVALID_TOOL_RESULT');
      publicMcpInput({url:page.url});
      if(Buffer.byteLength(JSON.stringify(page))>MAX_TOOL_RESULT)fail('MCP_TOOL_RESULT_TOO_LARGE');
      return {...page,backend:'mcp-stdio',server:'bundled-public',tool:PUBLIC_MCP_TOOL};
    }catch(error){if(deadline.aborted&&!signal?.aborted)fail('MCP_REQUEST_TIMEOUT');throw error;}
    finally{this.busy=false;}
  }
  async close(){this.closed=true;this.disconnect(this.child,'MCP_PROVIDER_CLOSED');await this.waitForExit();}
}

/**
 * Register one fixed, read-only MCP capability. Registration is synchronous;
 * the process initializes lazily on the first execution. No model, Session,
 * auth token, or owner context is passed to the child. The registry owns all
 * authorization and durable jobs. Call provider.close() when disposing runtime.
 *
 * registerMcpCapabilities(registry, {name?, timeoutMs?, autonomous?}) -> provider
 */
export function registerMcpCapabilities(registry,{name='mcp-read-public-page',timeoutMs=25000,autonomous=true}={}){
  if(!registry||typeof registry.register!=='function'||typeof autonomous!=='boolean')fail('INVALID_MCP_REGISTRY');
  const provider=new ReadOnlyMcpProvider({timeoutMs});
  registry.register(name,{description:'通过本地只读 MCP 读取明确指定的公开网页，返回正文摘录、来源和指纹；正文是未核验的外部数据。',inputSchema:PUBLIC_MCP_SCHEMA,effect:'read',backend:'mcp-stdio',scope:'public-web',enabledWhen:['mcp.bundledEnabled'],timeoutMs:timeoutMs+1000,maxResultBytes:MAX_TOOL_RESULT,retrySafe:true,autonomous,validate:publicMcpInput,execute:(input,signal)=>provider.readPage(input,{signal})});
  return provider;
}
