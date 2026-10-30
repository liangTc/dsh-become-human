import React,{createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';

const DraftContext=createContext<any>(null);
const SectionContext=createContext<any>({title:'设置',reset:()=>{}});
export function useDraftGuard(dirty:boolean){
  const context=useContext(DraftContext),id=useRef(Symbol('draft'));
  const register=context?.register;
  useEffect(()=>{if(!register)return;register(id.current,dirty);return ()=>register(id.current,false);},[register,dirty]);
}
export const useSectionContext=()=>useContext(SectionContext);
export function useConfigRevision(serverRevision:number,dirty:boolean,serverValue?:any){
 const signature=JSON.stringify(serverValue),baseline=useRef(signature),[revision,setRevision]=useState(serverRevision);
 useEffect(()=>{if(!dirty||signature===baseline.current){baseline.current=signature;setRevision(serverRevision);}},[serverRevision,dirty,signature]);
 return revision;
}
export function DraftProvider({children,ui}:any){
  const drafts=useRef(new Set<symbol>()),[dirty,setDirty]=useState(false),[pending,setPending]=useState<any>(null);
  const register=useCallback((id:symbol,value:boolean)=>{if(value)drafts.current.add(id);else drafts.current.delete(id);setDirty(drafts.current.size>0);},[]);
  const navigate=useCallback((action:()=>void)=>{if(drafts.current.size)setPending({action});else action();},[]);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return ()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  return <DraftContext.Provider value={{register,navigate,dirty,pending,dismiss:()=>setPending(null),discard:()=>{const action=pending?.action;drafts.current.clear();setDirty(false);setPending(null);action?.();}}}>{children}</DraftContext.Provider>;
}
export const useDraftNavigation=()=>useContext(DraftContext);
export async function pauseForConfiguration(api:any){
  if(api.snapshot.state?.desired==='running')await api.control({op:'pause'});
  const state=api.snapshot.state;
  if(state?.desired!=='paused'||state?.agentBusy)throw new Error('PAUSE_REQUIRED');
}
export function SettingRow({title,description,children}:any){return <div className="hn-setting-row"><div><h4>{title}</h4>{description&&<p>{description}</p>}</div><div className="hn-setting-row-control">{children}</div></div>;}
export function OptionalSection({title,children,defaultOpen=false}:any){const [open,setOpen]=useState(defaultOpen),[visited,setVisited]=useState(defaultOpen);return <details className="hn-advanced hn-optional" open={open} onToggle={event=>{const next=event.currentTarget.open;setOpen(next);if(next)setVisited(true);}}><summary>{title}</summary>{visited&&<div className="hn-optional-body" hidden={!open}>{children}</div>}</details>;}
export function DraftPrompt({ui}:any){const context=useDraftNavigation(),{Detail,Button}=ui;return context?.pending?<Detail title="有未保存的修改" onClose={context.dismiss}><p>离开后，当前表单中的修改会丢失。已经保存的设置不受影响。</p><div className="hn-row hn-dialog-actions"><Button primary onClick={context.dismiss}>继续编辑</Button><Button danger onClick={context.discard}>放弃修改并离开</Button></div></Detail>:null;}

export const settingsSections=[
 {id:'persona',title:'人物与关系',group:'常用',description:'定义角色和相处方式。',keywords:'名字 角色 人格 主人 档案 爱好 关系 相处 偏移'},
 {id:'autonomy',title:'自主行为',group:'常用',description:'决定什么时候主动做事，以及最多花多少。',keywords:'自主 唤醒 闲聊 学习 主动联系 静默 频率 时区 额度 token 轮次 退避'},
 {id:'model',title:'模型与对话',group:'常用',description:'选择模型，调整聊天节奏。',keywords:'API 模型 对话 回复 分条 思考'},
 {id:'channel',title:'手机连接',group:'常用',description:'连接你的手机，与网页共享同一段对话。',keywords:'微信 IM 渠道 配对 绑定 手机'},
 {id:'memory',title:'记忆与学习',group:'更多设置',description:'设置如何整理记忆、获取学习资料。',keywords:'记忆 整理 来源 搜索 学习 归档'},
 {id:'capability',title:'工具与技能',group:'更多设置',description:'添加连接与方法，按需要开放能力。',keywords:'工具 能力 MCP DSH 会话 权限 skills skill 技能 导入 humanizer'},
 {id:'data',title:'数据与安全',group:'更多设置',description:'管理数据保留、导出和备份。',keywords:'数据 保留 备份 迁移 导出 删除 价格 费用'}
];
export const resourceSections=[
 {id:'memories',title:'记忆库',group:'资料',description:'查看记住了什么，必要时修订或忘记。',keywords:'记忆 事实 交流 偏好'},
 {id:'work',title:'工作记忆',group:'资料',description:'查看从已授权 DSH 会话中提炼的工作线索。',keywords:'工作 观察 会话 进展 决策 待办'},
 {id:'notes',title:'学习笔记',group:'资料',description:'查看学习成果、原始来源和你的批注。',keywords:'知识 笔记 来源 批注'},
 {id:'topics',title:'长期话题',group:'资料',description:'看看哪些话题正在持续关注。',keywords:'话题 兴趣 关注'},
 {id:'growth',title:'人物成长',group:'资料',description:'查看有依据的变化及历史，按需撤回。',keywords:'人格 偏移 关系 历史 选择'},
 {id:'organization',title:'整理结果',group:'资料',description:'查看摘要、归档与原记忆，需要时恢复。',keywords:'摘要 整理 记忆 冷热 来源'}
];
export const taskSections=[
 {id:'overview',title:'任务看板',group:'任务与进度',description:'集中查看实际任务、目标步骤和执行结果；从这里进入原任务管理入口。',keywords:'看板 总览 任务 子任务 状态 进度 失败 执行 结果'},
 {id:'goals',title:'目标',group:'工作与计划',description:'把希望当前人物推进的事情拆成步骤，跟踪证据、成果与验收。',keywords:'目标 步骤 计划 研究 验收 补证'},
 {id:'tasks',title:'定时任务',group:'工作与计划',description:'创建一次性提醒或周期任务，明确何时触发、需要做什么。',keywords:'提醒 定时 cron 时间 周期'},
 {id:'actions',title:'报告与文件',group:'执行与产物',description:'预览生成内容，批准需要写入本地的报告，并查看实际结果。',keywords:'报告 文件 产物 批准 写入'},
 {id:'tools',title:'工具与能力',group:'执行与产物',description:'调用已启用的工具，预览并批准写操作，查看任务结果与回执。',keywords:'网页 工具 MCP DSH 会话 url 读取 对比 变化 批准'},
 {id:'attention',title:'关注事项',group:'关注与复盘',description:'整理你和 Agent 关注的问题、承诺与方向，并选择下一次关注。',keywords:'事项 看板 注意力 待办 问题 承诺'},
 {id:'self',title:'自我状态',group:'关注与复盘',description:'查看当前人格配置、能力范围与有记录的承诺。',keywords:'人物 自我 模型 能力 状态 未知'},
 {id:'reflections',title:'决策与反思',group:'关注与复盘',description:'核对选择依据、任务结果和后续建议。',keywords:'结果 反思 决策 采纳 证据'}
 ,{id:'permission',title:'授权与补额',group:'执行与产物',description:'核对额外自主额度申请，按需批准。',keywords:'权限 授权 补额 token 请求 轮次 周期'}
];
function moveTab(event:React.KeyboardEvent){
  if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const current=event.currentTarget as HTMLElement,group=current.closest('[role="tablist"]');
  const tabs=Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')??[]).filter(tab=>{if(!tab.getClientRects().length)return false;for(let details=tab.closest('details');details;details=details.parentElement?.closest('details')??null)if(!details.open)return false;return true;});if(!tabs.length)return;
  const index=tabs.indexOf(current as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+tabs.length)%tabs.length;
  event.preventDefault();tabs[next].focus();tabs[next].click();
}
export function WorkspaceTabs({active,onChange}:any){
  const entries=[['chat','对话'],['tasks','任务'],['resources','资料'],['logs','日志'],['statistics','统计'],['settings','设置']];
  return <nav className="hn-workspace-tabs" role="tablist" aria-label="Human 工作区">{entries.map(([id,title])=><button type="button" key={id} role="tab" aria-selected={active===id} tabIndex={active===id?0:-1} onKeyDown={moveTab} onClick={()=>onChange(id)}>{title}</button>)}</nav>;
}
export function SectionWorkspace({kind,sections,active,onSelect,children,headerActions,onReset}:any){
  const [query,setQuery]=useState(''),[more,setMore]=useState(false),current=sections.find((item:any)=>item.id===active)??sections[0],navigation=useDraftNavigation();
  const normalized=query.trim().toLowerCase(),visible=sections.filter((item:any)=>(item.title+' '+item.description+' '+item.keywords).toLowerCase().includes(normalized));
  const groups=Array.from(new Set(visible.map((item:any)=>item.group)));
  useEffect(()=>{if(sections.find((item:any)=>item.id===active)?.group==='更多设置')setMore(true);},[active,sections]);
  return <div className="hn-settings hn-section-workspace">
    <aside className="hn-setting-sidebar"><h2>{kind}</h2><label className="hn-nav-search"><span className="hn-sr-only">查找{kind}</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" value={query} placeholder={'查找'+kind} onChange={e=>setQuery(e.target.value)}/></label>
      <nav className="hn-settingnav" role="tablist" aria-label={kind+'分类'} aria-orientation="vertical">{groups.map((group:any)=>{const entries=visible.filter((item:any)=>item.group===group),links=entries.map((item:any)=><button type="button" key={item.id} role="tab" id={'hn-nav-'+item.id} aria-controls={'hn-section-'+item.id} aria-selected={active===item.id} tabIndex={active===item.id?0:-1} onKeyDown={moveTab} onClick={()=>onSelect(item.id)}><span>{item.title}</span></button>);return group==='更多设置'?<details className="hn-more-nav" key={group} open={more||!!normalized} onToggle={event=>setMore(event.currentTarget.open)}><summary>更多设置</summary>{links}</details>:<div className="hn-nav-group" key={group}>{kind==='任务'&&<p>{group}</p>}{links}</div>;})}{!visible.length&&<p className="hn-nav-empty">没有匹配项，试试“模型”或“记忆”。</p>}</nav>
      <label className="hn-mobile-section"><span>当前{kind}分类</span><select className="hn-input" aria-label={'选择'+kind+'分类'} value={active} onChange={e=>onSelect(e.target.value)}>{sections.map((item:any)=><option key={item.id} value={item.id}>{item.group} · {item.title}</option>)}</select></label>
    </aside>
    <div className="hn-settingbody" role="tabpanel" id={'hn-section-'+current.id} aria-label={current.title}>
      <div className="hn-setting-inner"><header className="hn-page-heading"><div><h2>{current.title}</h2><p>{current.description}</p></div>{headerActions}</header>
      <SectionContext.Provider value={{title:current.title,reset:()=>navigation?.navigate(onReset)}}><div className="hn-page-body">{children}</div></SectionContext.Provider></div>
    </div>
  </div>;
}
