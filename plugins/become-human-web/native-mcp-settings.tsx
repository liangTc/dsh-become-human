import React,{useState} from 'react';

export function draftMcpServers(servers:any[]=[]){
  return servers.map(server=>({server:structuredClone(server),argsText:JSON.stringify(server.args??[],null,2),envText:Object.entries(server.env??{}).map(([name,ref])=>name+'='+ref).join('\n'),headerText:Object.entries(server.headerEnv??{}).map(([name,ref])=>name+'='+ref).join('\n'),discovered:null}));
}
function references(text:string,label:string){
  const entries=text.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const at=line.indexOf('='),name=line.slice(0,at).trim(),ref=line.slice(at+1).trim();
    if(at<1||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)||!/^MCP_[A-Z0-9_]{1,100}$/.test(ref)||['__proto__','constructor','prototype'].includes(name))throw new Error(label+'请按“目标名称=MCP_环境变量名”填写，不填写密钥原文。');
    return [name,ref];
  });
  if(new Set(entries.map(([name])=>name)).size!==entries.length)throw new Error(label+'存在重复名称。');
  return Object.fromEntries(entries);
}
export function serializeMcpServer(row:any){
  const server=row.server;
  let args:any[]=[];
  if(server.transport==='stdio'){
    try{args=row.argsText.trim().startsWith('[')?JSON.parse(row.argsText):row.argsText.split(/\r?\n/).map((line:string)=>line.trim()).filter(Boolean);}catch{throw new Error('启动参数需要每行一个，或填写有效的 JSON 字符串数组。');}
    if(!Array.isArray(args)||args.some(item=>typeof item!=='string'))throw new Error('启动参数只能是字符串数组。');
  }
  return {id:server.id,name:server.name,enabled:server.enabled===true,transport:server.transport,timeoutMs:server.timeoutMs??25000,tools:(server.tools??[]).map(({name,description,inputSchema,schemaHash,effect,enabled}:any)=>({name,description,inputSchema,schemaHash,effect,enabled:enabled===true})),...(server.transport==='stdio'?{command:server.command??'',args,...(server.cwd?{cwd:server.cwd}:{}),env:references(row.envText,'进程环境引用')}:{url:server.url??'',headerEnv:references(row.headerText,'HTTP 请求头引用')})};
}
export const serializeMcpServers=(rows:any[])=>rows.map(serializeMcpServer);

export default function McpConnections({api,s,ui,busy,rows,onChange,expectedRevision}:any){
  const {Button,Field,Input,Text,Select,Check,JsonDetails}=ui;
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set(rows.filter((row:any)=>!row.server.command&&!row.server.url).map((row:any)=>row.server.id)));
  const setOpen=(id:string,open:boolean)=>setExpanded(previous=>{if(previous.has(id)===open)return previous;const next=new Set(previous);open?next.add(id):next.delete(id);return next;});
  const patch=(index:number,value:any)=>onChange(rows.map((row:any,i:number)=>i===index?{...row,...value}:row));
  const serverPatch=(index:number,value:any)=>patch(index,{server:{...rows[index].server,...value}});
  const discover=(row:any)=>api.run(async()=>{
    if(s.desired!=='paused'||s.agentBusy)throw new Error('请先暂停 Human，再连接服务发现工具。');
    const result=await api.control({op:'capability-mcp-discover',sessionId:s.sessionId,expectedRevision,server:serializeMcpServer(row)}),found=result.mcpDiscovery;
    if(!found||found.serverId!==row.server.id||!Array.isArray(found.tools))throw new Error('未取得有效的 MCP 工具列表。');
    const old=new Map((row.server.tools??[]).map((tool:any)=>[tool.name,tool]));
    const tools=found.tools.filter((tool:any)=>tool.supported).map(({name,description,inputSchema,schemaHash}:any)=>{
      const prior:any=old.get(name),same=prior?.schemaHash===schemaHash;
      return {name,description,inputSchema,schemaHash,enabled:same&&prior.enabled===true,effect:same?prior.effect:'write'};
    });
    const currentIndex=rows.findIndex((item:any)=>item.server.id===row.server.id);
    if(currentIndex>=0){patch(currentIndex,{server:{...row.server,tools},discovered:found.tools});setOpen(row.server.id,true);}
  },'已发现工具，请逐项选择权限并保存；发现不会执行工具');
  const add=()=>{const id='mcp-'+crypto.randomUUID().slice(0,8);setOpen(id,true);onChange([...rows,...draftMcpServers([{id,name:'新 MCP 服务',enabled:false,transport:'stdio',command:'',args:[],env:{},timeoutMs:25000,tools:[]}])]);};
  return <>
    <div className="hn-row hn-between"><p className="hn-help">添加自己的 MCP 服务，发现工具后逐项开放。新增服务和工具默认关闭。</p><Button disabled={busy||rows.length>=8} onClick={add}>添加 MCP 服务</Button></div>
    <p className="hn-help">本地服务以你的系统账户运行，请使用可信程序；只读标记不提供系统沙盒。当前自定义工具由用户对话或工具页面发起，不会自动进入无人值守自主任务。连接参数会进入配置导出，密钥请使用环境变量引用。</p>
    {!rows.length&&<p className="hn-note">尚未添加自定义服务。支持本地 stdio 和远程 Streamable HTTP，最多 8 个服务。</p>}
    {rows.map((row:any,index:number)=>{
      const server=row.server,found=row.discovered??(server.tools??[]).map((tool:any)=>({...tool,supported:true})),grants=new Map((server.tools??[]).map((tool:any)=>[tool.name,tool]));
      return <details className="hn-group" key={server.id} open={expanded.has(server.id)} onToggle={event=>setOpen(server.id,event.currentTarget.open)}>
        <summary>{server.name||'未命名 MCP'} · {server.transport==='http'?'HTTP':'本地 stdio'} · {server.enabled?'已启用':'未启用'} · {(server.tools??[]).filter((tool:any)=>tool.enabled).length} 项开放工具</summary>
        <div className="hn-row hn-between"><Check label="启用此 MCP 服务" disabled={busy} value={server.enabled} onChange={(enabled:boolean)=>serverPatch(index,{enabled})}/><Button danger disabled={busy} onClick={()=>onChange(rows.filter((item:any)=>item.server.id!==server.id))}>移除此服务</Button></div>
        <div className="hn-fields">
          <Field label="服务名称"><Input value={server.name} maxLength={80} disabled={busy} onChange={(name:string)=>serverPatch(index,{name})}/></Field>
          <Field label="连接方式"><Select value={server.transport} disabled={busy} options={[["stdio","本地程序 · stdio"],["http","远程地址 · Streamable HTTP"]]} onChange={(transport:string)=>serverPatch(index,{transport})}/></Field>
          {server.transport==='stdio'?<>
            <Field wide label="可执行文件的完整路径" hint="例如 C:\Program Files\nodejs\node.exe。Windows 使用 .exe；不直接启动 .cmd、.bat 或 .ps1。"><Input value={server.command??''} maxLength={2048} disabled={busy} onChange={(command:string)=>serverPatch(index,{command})}/></Field>
            <Field wide label="启动参数 · 每行一个，或 JSON 字符串数组" hint="Node MCP 可填写服务器脚本路径；使用 npx 包时，以 node.exe 启动本机 npx-cli.js，并将包名等作为后续参数。程序和包需自行准备。"><Text value={row.argsText} rows={3} maxLength={65536} disabled={busy} onChange={(argsText:string)=>patch(index,{argsText})}/></Field>
            <Field wide label="工作目录 · 可留空" hint="填写完整路径；留空使用可执行文件所在目录。"><Input value={server.cwd??''} maxLength={2048} disabled={busy} onChange={(cwd:string)=>serverPatch(index,{cwd})}/></Field>
            <Field wide label="进程环境引用 · 每行一项" hint="例如 API_KEY=MCP_SERVICE_KEY。右侧只能填写专用 MCP_ 环境变量名；密钥在启动 DSH 的系统环境中设置，服务不会继承模型密钥。"><Text value={row.envText} rows={2} disabled={busy} maxLength={8192} onChange={(envText:string)=>patch(index,{envText})}/></Field>
          </>:<>
            <Field wide label="MCP HTTP 地址" hint="填写完整 Streamable HTTP 端点，例如 https://example.com/mcp；本机服务也可使用 http://127.0.0.1:端口/mcp。地址中不放密钥或查询参数。"><Input value={server.url??''} maxLength={2048} disabled={busy} onChange={(url:string)=>serverPatch(index,{url})}/></Field>
            <Field wide label="HTTP 请求头引用 · 每行一项" hint="例如 Authorization=MCP_AUTH_HEADER。环境变量中填写完整请求头值（需要时含 Bearer 前缀）；这里不填写密钥。"><Text value={row.headerText} rows={2} maxLength={8192} disabled={busy} onChange={(headerText:string)=>patch(index,{headerText})}/></Field>
          </>}
          <Field label="连接与调用超时 · 秒" hint="1–60 秒，实际调用也受全局单次执行上限约束。"><Input type="number" min={1} max={60} value={(server.timeoutMs??25000)/1000} disabled={busy} onChange={(seconds:number)=>serverPatch(index,{timeoutMs:Math.round(seconds*1000)})}/></Field>
        </div>
        <div className="hn-row"><Button disabled={busy||s.agentBusy||s.desired!=='paused'} onClick={()=>discover(row)}>连接并发现工具</Button><small className="hn-help">发现会连接或启动此服务，只读取工具目录，不执行工具。请先暂停 Human。</small></div>
        {!!found.length&&<><h4 className="hn-section-heading">工具权限</h4><p className="hn-help">“关闭”不开放；“只读”由你明确确认后开放读取；“逐笔批准”适用于写入及其他外部操作。服务器自报只读不会自动获得权限。参数约束不兼容的工具会显示原因。</p>
          {found.map((tool:any)=>{
            const grant:any=grants.get(tool.name),mode=grant?.enabled?grant.effect:'disabled';
            return <div className="hn-group" key={tool.name}><strong>{tool.name}</strong>{tool.description&&<p className="hn-help">{tool.description}</p>}
              <Field label={tool.name+' 的权限'}><Select disabled={busy||!tool.supported} value={mode} options={[["disabled","关闭"],["read","只读 · 由我确认此工具仅读取"],["write","外部操作 · 每次预览批准"]]} onChange={(value:string)=>serverPatch(index,{tools:(server.tools??[]).map((item:any)=>item.name===tool.name?{...item,enabled:value!=='disabled',effect:value==='disabled'?item.effect:value}:item)})}/></Field>
              {!tool.supported&&<p className="hn-help">当前不支持：{ui.errorText?.(tool.unsupportedReason)??tool.unsupportedReason}。此工具无法启用。</p>}<JsonDetails label="查看参数与服务器声明" value={{inputSchema:tool.inputSchema,annotations:tool.annotations??{},schemaHash:tool.schemaHash}}/>
            </div>;
          })}</>}
        <p className="hn-note">服务编号：{server.id}。连接、参数或工具定义变更后，旧任务与审批需要重新核对。修改完成后点击本页“保存工具与连接”。</p>
      </details>;
    })}
  </>;
}
