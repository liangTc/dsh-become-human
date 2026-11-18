import React,{useEffect,useRef,useState} from 'react';

const messages:Record<string,string>={
 UPDATE_SOURCE_INSTALL:'当前为源码或外部链接安装，请通过原安装方式更新，以免覆盖开发文件。',
 UPDATE_PROFILE_UNAVAILABLE:'无法确认当前 DSH 安装环境，请使用命令行更新。',
 UPDATE_INSTALLATION_INVALID:'当前安装文件不完整，请先修复安装。',
 UPDATE_INSTALLATION_CHANGED:'安装配置已变化，请重新检查更新。',
 UPDATE_NODE_INCOMPATIBLE:'新版需要其他 Node.js 版本，请先升级 Node.js。',
 UPDATE_DSH_INCOMPATIBLE:'新版与当前 DSH 版本不兼容，请先查看版本要求。',
 UPDATE_RELEASE_NOT_FOUND:'此通道还没有发布版本。',
 UPDATE_STABLE_UNAVAILABLE:'正式版尚未发布，请选择测试版 Beta 通道。',
 UPDATE_DOWNLOAD_FAILED:'无法连接 npm 或下载安装包，请检查网络后重试。',
 UPDATE_RELEASE_INVALID:'发布信息校验失败，未安装。',
 UPDATE_INTEGRITY_FAILED:'安装包完整性校验失败，未安装。',
 UPDATE_ARCHIVE_INVALID:'安装包内容不符合 Human 插件格式，未安装。',
 UPDATE_FILE_TOO_LARGE:'下载内容超过允许大小，已停止。',
 UPDATE_CHECK_EXPIRED:'版本检查已过期，请重新检查后更新。',
 UPDATE_NOT_NEWER:'没有可升级版本，不会覆盖同版本或降级。',
 UPDATE_BUSY:'已有更新任务正在执行，请等待。',
 UPDATE_INTERRUPTED:'更新被中断。请检查状态，必要时恢复更新前版本。',
 UPDATE_OPERATION_FAILED:'安装未完成。可尝试恢复更新前版本；离线缓存缺失时需通过命令行修复。',
 UPDATE_RECOVERY_CONFLICT:'更新后安装配置又发生变化，不能自动覆盖，请手动处理。',
 UPDATE_IDENTITY_CHANGED:'会话或渠道绑定与更新前不一致，已停止启动，请检查。',
 UPDATE_RESTART_OR_RECOVERY_REQUIRED:'请先完成重启或恢复更新前版本。',
 UPDATE_STATE_UNAVAILABLE:'无法保存或读取更新记录，已停止更新。',
 UPDATE_VERIFY_FAILED:'安装后的文件核验失败，请恢复更新前版本。',
 UPDATE_OTHER_PLUGIN_CHANGED:'安装影响了其他插件的依赖，已停止生效，请恢复。',
 UPDATE_CONFIGURATION_CHANGED:'安装配置与更新前不一致，已停止生效，请检查或恢复。',
 UPDATE_RUNTIME_NOT_READY:'Human 后台未就绪，请先恢复服务再更新。',
};
const phases:Record<string,string>={preparing:'下载并校验安装包',installing:'保留配置并安装',verifying:'核验安装结果','restart-required':'安装完成，等待重启 DSH','rollback-restart-required':'旧版已恢复，等待重启 DSH',completed:'更新已生效',failed:'更新失败',interrupted:'更新中断',recovering:'恢复更新前版本','recovery-required':'需要恢复或手动处理',restored:'已恢复更新前版本'};
export default function HumanUpdate({api,ui}:any){
 const {Button,Select,Field,Band,Detail}=ui,[data,setData]=useState<any>(null),[error,setError]=useState(''),[pending,setPending]=useState(false),[confirm,setConfirm]=useState(false),[channel,setChannel]=useState('beta');
 const alive=useRef(true),request=useRef<any>(null),refreshing=useRef(false),initialized=useRef(false);
 useEffect(()=>{alive.current=true;async function load(){if(refreshing.current)return;refreshing.current=true;try{const next=await api.read({kind:'update'});if(alive.current){setData(next);if(!initialized.current){setChannel(next.channel);initialized.current=true;}}}catch(e:any){if(alive.current)setError(e.message);}finally{refreshing.current=false;}}void load();const timer=setInterval(load,3000);return ()=>{alive.current=false;clearInterval(timer);};},[api]);
 async function perform(work:()=>Promise<any>){setPending(true);setError('');try{const next=await work();if(alive.current)setData(next);}catch(e:any){if(alive.current)setError(e.message);}finally{if(alive.current)setPending(false);}}
 const busy=pending||data?.busy,job=data?.job,restart=['restart-required','rollback-restart-required'].includes(job?.state),text=(value:string)=>messages[value]??value;
 return <section className="hn-update"><h3>版本与更新</h3><p className="hn-help">在当前 DSH 中更新 Human 管理页面和后台模块，保留人物、记忆、会话及手机绑定。</p>
 <div className="hn-update-versions"><div><span>当前运行</span><strong>{data?.runningVersion??'读取中…'}</strong></div><div><span>可用版本</span><strong>{data?.latestVersion??'尚未检查'}</strong></div></div>
 <Field label="更新通道" hint="测试版包含新功能和修复，仍可能存在问题。"><Select aria-label="更新通道" value={channel} disabled={busy||restart} options={[["beta","测试版 Beta"],["latest","正式版"]]} onChange={(value:string)=>{setChannel(value);setData((previous:any)=>({...previous,canInstall:false,latestVersion:null}));}}/></Field>
 <div className="hn-row hn-update-buttons"><Button disabled={busy||restart} onClick={()=>perform(()=>api.control({op:'update-check',channel}))}>检查更新</Button><Button primary disabled={busy||!data?.canInstall||channel!==data?.channel} onClick={()=>{request.current=null;setConfirm(true);}}>一键更新</Button></div>
 {data?.checkedAt&&<p className="hn-help">上次检查：{new Date(data.checkedAt).toLocaleString('zh-CN')}{data.latestVersion===data.runningVersion?' · 已是该通道最新版本':''}</p>}
 {data?.blockedReason&&!restart&&<Band>{text(data.blockedReason)}</Band>}
 {error&&<Band><span role="alert">{text(error)}</span></Band>}
 {job&&<div className="hn-update-job" role="status" aria-live="polite"><strong>{phases[job.state]??job.state}</strong><p>{job.previousVersion} → {job.targetVersion}</p>{job.error&&<p>{text(job.error)}</p>}{job.recoveryError&&<p>{text(job.recoveryError)}</p>}
 {restart&&<p>请重启当前 DSH 应用或原启动服务，再刷新本页。安装完成不等于已生效；重启后会核对原会话，并保留原运行设置。更新期间 Human 后台暂停。</p>}
 {job.state==='completed'&&<p>当前进程已加载新版，并完成原会话与渠道绑定核对。</p>}
 {data.canRecover&&<Button disabled={busy} onClick={()=>perform(()=>api.control({op:'update-apply',action:'recover',jobId:job.id,requestId:crypto.randomUUID().replaceAll('-','')}))}>恢复更新前版本</Button>}</div>}
 <p className="hn-help">更新会短暂停止 Human 后台。DSH 宿主需要重启才能加载新版；请先保存其他会话的工作。这里保留安装配置用于失败恢复，不替代完整数据备份。</p>
 {confirm&&<Detail title="确认更新 Human" onClose={()=>{if(!busy)setConfirm(false);}}><p>将安装 {data?.latestVersion}，校验通过后暂停 Human 后台。下载失败不会停止原运行。</p><p>会话、记忆和手机绑定保留。安装后需要重启 DSH 生效；不会自动重发旧消息或重试失败任务。</p><div className="hn-row"><Button disabled={busy} onClick={()=>setConfirm(false)}>取消</Button><Button primary disabled={busy} onClick={()=>{request.current??={op:'update-apply',action:'install',checkId:data.checkId,requestId:crypto.randomUUID().replaceAll('-',''),confirm:true};void perform(async()=>{const result=await api.control(request.current);setConfirm(false);return result;});}}>确认更新</Button></div></Detail>}
 </section>;
}
