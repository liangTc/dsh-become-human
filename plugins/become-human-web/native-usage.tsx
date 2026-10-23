import React,{useEffect,useRef,useState} from 'react';
import css from './native-usage.css';

type Period='24h'|'current-window';
type Metrics={
  attempts?:number;requests?:number;actualTokens?:number|null;reportedTokens?:number;
  reportedInputTokens?:number;reportedOutputTokens?:number;reportedCacheReadTokens?:number;reportedCacheWriteTokens?:number;
  reportedUsageRequests?:number;unknownUsageRequests?:number;pendingRequests?:number;preparedRequests?:number;
  notDispatchedRequests?:number;failedRequests?:number;cancelledRequests?:number;waitRequests?:number;
  settledConservativeTokens?:number;pendingReservedTokens?:number;conservativeTokens?:number;
  autonomousRequests?:number;foregroundRequests?:number;partialReportedTokens?:number;partialUsageRequests?:number;
  detailUnknownRequests?:{input:number;output:number;cacheRead:number;cacheWrite:number};
};
type UsageData={version:number;period:Period;generatedAt:number;range:any;overall:Metrics;categories:any[];models:any[];hourly:any[];currentQuota?:any;notes?:string[];warnings?:any[]};
const number=(value:any)=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'待确认';
const amount=(value:any)=>typeof value==='number'&&Number.isFinite(value)?value:0;
const shortNumber=(value:number)=>value>=1000000?(value/1000000).toFixed(value<10000000?1:0)+'M':value>=1000?(value/1000).toFixed(value<10000?1:0)+'k':String(value);
const warningLabels:any={ATTEMPT_TABLE_UNAVAILABLE:'请求账本当前不可读取，请求次数与 token 总量尚不能确认。',SIGNED_LEDGER_UNAVAILABLE:'自主签名账本当前不可读取，保守占额与自主额度尚不能确认。',WORK_CATEGORY_UNAVAILABLE:'部分历史工作类别缺失，已列入“其他 / 历史未分类”。',LEGACY_DISPATCH_INFERRED:'部分早期请求缺少分发标记，已根据保留的模型配置或用量恢复分类。',REPORTED_USAGE_INVALID_OR_MISSING:'部分供应商用量记录不完整，已列为待确认。',QUOTA_CLOCK_HIGH_WATER:'额度账本时间领先当前系统时间，当前额度周期以账本时间为准，请核对系统时钟。'};
const dateTime=(value:any)=>value!=null&&Number.isFinite(Number(value))?new Date(Number(value)).toLocaleString('zh-CN',{hour12:false}):'尚未更新';
function offsetLabel(offset:any){if(!Number.isFinite(offset))return '本机时间';return 'UTC'+(offset>=0?'+':'−')+String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')+':'+String(Math.abs(offset)%60).padStart(2,'0');}
function windowTime(value:any,offset:any,full=false){
  if(value==null||!Number.isFinite(Number(value)))return '待确认';
  if(!Number.isFinite(offset))return new Date(Number(value)).toLocaleString('zh-CN',{hour12:false});
  const d=new Date(Number(value)+offset*60000),day=d.toISOString().slice(5,10).replace('-','/'),hour=d.toISOString().slice(11,16);
  return full?day+' '+hour:hour;
}

// Reads are serial within a mounted view. A new period or Session invalidates
// earlier results; a failed refresh keeps the last successful snapshot visible.
function useUsageRead(api:any,sessionId:string,period:Period){
  const scope=JSON.stringify([sessionId,period]),[nonce,setNonce]=useState(0),sequence=useRef(0);
  const [state,setState]=useState<any>({scope,data:null,error:'',loading:true});
  useEffect(()=>{
    const generation=++sequence.current;
    let active=true,inflight=false,timer:ReturnType<typeof setTimeout>|undefined;
    const current=()=>active&&sequence.current===generation;
    const stopTimer=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
    const read=async()=>{
      if(!current()||inflight||document.visibilityState==='hidden')return;
      stopTimer();inflight=true;
      setState((old:any)=>({scope,data:old.scope===scope?old.data:null,error:'',loading:true}));
      try{
        const data=await api.read({kind:'usage-statistics',period});
        if(current())setState({scope,data,error:'',loading:false});
      }catch(error:any){
        if(current())setState((old:any)=>({scope,data:old.scope===scope?old.data:null,error:error?.message??'USAGE_READ_FAILED',loading:false}));
      }finally{
        inflight=false;
        if(current()&&document.visibilityState!=='hidden')timer=setTimeout(read,30000);
      }
    };
    const visibility=()=>{stopTimer();if(document.visibilityState!=='hidden')void read();};
    setState((old:any)=>({scope,data:old.scope===scope?old.data:null,error:'',loading:document.visibilityState!=='hidden'}));
    document.addEventListener('visibilitychange',visibility);
    void read();
    return ()=>{active=false;stopTimer();document.removeEventListener('visibilitychange',visibility);};
  },[api,scope,period,nonce]);
  return {...(state.scope===scope?state:{scope,data:null,error:'',loading:true}),refresh:()=>setNonce(value=>value+1)};
}

function MetricCard({label,value,unit,detail,tone=''}:any){
  return <article className="hn-usage-metric" data-tone={tone}><h3>{label}</h3><div className="hn-usage-number"><strong>{number(value)}</strong><span>{unit}</span></div><p>{detail}</p></article>;
}

function MetricDetails({row}: {row:Metrics}){
  const tokenDetails=[['已报告输入',row.reportedInputTokens,row.detailUnknownRequests?.input],['已报告输出',row.reportedOutputTokens,row.detailUnknownRequests?.output],['已报告缓存读取',row.reportedCacheReadTokens,row.detailUnknownRequests?.cacheRead],['已报告缓存写入',row.reportedCacheWriteTokens,row.detailUnknownRequests?.cacheWrite]];
  return <div className="hn-usage-details">
    <dl className="hn-usage-detail-grid">
      {tokenDetails.map(([label,value,missing])=><div key={String(label)}><dt>{label}</dt><dd>{amount(missing)>0&&amount(missing)>=amount(row.requests)?'未获明细':<>{number(value)} <small>token</small></>}{amount(missing)>0?<small className="hn-usage-missing">{number(missing)} 次请求未提供最终明细</small>:null}</dd></div>)}
      {[
        ['已报告用量',row.reportedUsageRequests,'次请求'],['用量待确认',row.unknownUsageRequests,'次请求'],
        ['中途报告，未确认最终',row.partialReportedTokens,'token'],['等待模型完成',row.pendingRequests,'次请求'],
        ['已结算保守占额',row.settledConservativeTokens,'token'],['尚未结算预留',row.pendingReservedTokens,'token'],
        ['失败',row.failedRequests,'次请求'],['取消',row.cancelledRequests,'次请求'],
        ['选择等待',row.waitRequests,'次请求'],['准备后未分发',row.notDispatchedRequests,'次尝试'],
        ['准备中，未分发',row.preparedRequests,'次尝试'],
      ].map(([label,value,unit])=><div key={String(label)}><dt>{label}</dt><dd>{number(value)} <small>{unit}</small></dd></div>)}
    </dl>
    <p className="hn-usage-caption">未缓存输入、输出、缓存读取与写入是独立分项；供应商缺少总量时，由有效分项求和。缺失的明细显示为未提供，不视为零。失败、取消或选择等待也可能消耗 token。</p>
  </div>;
}

function HourlyChart({rows,offset,metric}:any){
  const values=rows.map((row:any)=>amount(row[metric])),maximum=Math.max(1,...values),width=900,height=196,top=18,bottom=160,left=56,right=12,plotWidth=width-left-right,step=plotWidth/Math.max(1,rows.length),barWidth=Math.max(2,Math.min(24,step*.65));
  const title=metric==='requests'?'每小时模型请求次数':'每小时供应商已报告 token';
  return <figure className="hn-usage-chart"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
    <title>{title}</title><desc>横轴是时间，纵轴是{metric==='requests'?'本地已分发的模型请求次数，不表示供应商收费次数':'供应商最终已报告的 token 数'}。用量未确认的请求以圆点标识，不推算为零消耗。下方可展开每小时数字查看完整表格。</desc>
    {(maximum<=2?[0,1]:[0,.5,1]).map(fraction=><g key={fraction}><line x1={left} y1={bottom-(bottom-top)*fraction} x2={width-right} y2={bottom-(bottom-top)*fraction} className="hn-usage-chart-grid"/><text x={left-10} y={bottom-(bottom-top)*fraction+4} textAnchor="end" className="hn-usage-chart-label">{shortNumber(Math.round(maximum*fraction))}</text></g>)}
    {rows.map((row:any,index:number)=>{
      const value=values[index],barHeight=value/maximum*(bottom-top),x=left+step*(index+.5),unknown=amount(row.unknownUsageRequests);
      return <g key={row.start}>
        <rect x={x-barWidth/2} y={bottom-barHeight} width={barWidth} height={Math.max(0,barHeight)} rx={Math.min(3,barWidth/3)} className="hn-usage-chart-bar"><title>{windowTime(row.start,offset,true)}—{windowTime(row.end,offset)}：{number(row.reportedTokens)} 已报告 token，{number(row.requests)} 次模型请求，{number(row.unknownUsageRequests)} 次用量待确认。</title></rect>
        {unknown>0?<circle cx={x} cy={Math.max(top+3,bottom-barHeight-6)} r={3} className="hn-usage-chart-pending"><title>{unknown} 次请求的最终用量待确认</title></circle>:null}
        {index===0||index===rows.length-1||index%Math.max(1,Math.ceil(rows.length/7))===0?<text x={x} y={bottom+24} textAnchor="middle" className="hn-usage-chart-label">{windowTime(row.start,offset)}</text>:null}
      </g>;
    })}
  </svg><figcaption><span className="hn-usage-legend"><i/> {metric==='requests'?'模型请求':'已报告 token'}</span><span className="hn-usage-legend hn-usage-legend-pending"><i/> 用量待确认</span><span>按请求开始时间归属 · {offsetLabel(offset)}</span></figcaption>
  <details className="hn-usage-hours"><summary>查看每小时数字</summary><div className="hn-usage-table-scroll"><table><caption className="hn-sr-only">按小时统计的已报告 token、模型请求与用量待确认次数</caption><thead><tr><th scope="col">时间</th><th scope="col">已报告 token</th><th scope="col">模型请求</th><th scope="col">用量待确认</th></tr></thead><tbody>{rows.map((row:any)=><tr key={row.start}><th scope="row">{windowTime(row.start,offset,true)}—{windowTime(row.end,offset)}</th><td>{number(row.reportedTokens)}</td><td>{number(row.requests)} 次</td><td>{number(row.unknownUsageRequests)} 次</td></tr>)}</tbody></table></div></details></figure>;
}

function CategoryList({rows,total,ui}:any){
  const {Empty}=ui,maximum=Math.max(1,...rows.map((row:any)=>amount(row.reportedTokens))),sorted=rows.filter((row:any)=>amount(row.attempts)>0||amount(row.requests)>0||amount(row.reportedTokens)>0).sort((a:any,b:any)=>amount(b.reportedTokens)-amount(a.reportedTokens)||amount(b.requests)-amount(a.requests));
  if(!sorted.length)return <Empty>这个时间段还没有模型请求记录。外部工具费用不在此统计。</Empty>;
  return <div className="hn-usage-category-list">{sorted.map((row:any)=><details className="hn-usage-category" key={row.id}>
    <summary><div className="hn-usage-category-title"><span className="hn-usage-chevron" aria-hidden="true">›</span><strong>{row.label}</strong><span>{number(row.requests)} 次请求</span></div><div className="hn-usage-category-value"><strong>{number(row.reportedTokens)}</strong><span>token</span><small>{amount(total)>0?(amount(row.reportedTokens)/amount(total)*100).toFixed(1)+'%':'—'}</small></div><div className="hn-usage-bar" aria-hidden="true"><i style={{width:(amount(row.reportedTokens)/maximum*100)+'%'}}/></div>{amount(row.unknownUsageRequests)>0?<p className="hn-usage-category-warning">{number(row.unknownUsageRequests)} 次用量待确认{amount(row.pendingRequests)>0?'，其中 '+number(row.pendingRequests)+' 次尚未完成':''}</p>:null}</summary>
    <MetricDetails row={row}/>
  </details>)}</div>;
}

function ModelList({rows,ui}:any){
  const {Empty}=ui;
  return rows.length?<div className="hn-usage-models">{rows.map((row:any)=><details className="hn-usage-model" key={row.provider+'|'+row.model}><summary><div><strong>{!row.model||row.model==='unknown'?'模型未记录':row.model}</strong><p>{!row.provider||row.provider==='unknown'?'供应商未记录':row.provider}</p></div><div><strong>{number(row.reportedTokens)} <small>token</small></strong><p>{number(row.requests)} 次请求{amount(row.unknownUsageRequests)>0?' · '+number(row.unknownUsageRequests)+' 次用量待确认':''}</p></div><span className="hn-usage-chevron" aria-hidden="true">›</span></summary><MetricDetails row={row}/></details>)}</div>:<Empty>这个时间段还没有模型请求。</Empty>;
}

function QuotaSummary({quota,offset}:any){
  if(!quota)return null;
  return <details className="hn-usage-quota"><summary>当前自主额度周期 · {quota.available===false?'暂时无法读取':quota.quotaEnabled?'限制已开启':'未启用限制'}</summary>
    <p className="hn-usage-caption">{windowTime(quota.windowStart,offset,true)}—{windowTime(quota.windowEnd??quota.resetAt??quota.now,offset,true)} · {offsetLabel(offset)}。以下仅显示自主额度账本，与上方含主人沟通的统计范围分开核算。{quota.includesRetiredSessionLedger?'包含更换 Human 会话后延续的额度用量。':''}</p>
    <dl className="hn-usage-detail-grid">
      <div><dt>自主保守占额</dt><dd>{number(quota.reservedTokens)} <small>token</small></dd></div><div><dt>自主模型请求</dt><dd>{number(quota.dispatchedRequests)} <small>次</small></dd></div><div><dt>自主轮次</dt><dd>{number(quota.rounds)} <small>轮</small></dd></div><div><dt>未结算预留</dt><dd>{number(quota.pendingReservedTokens)} <small>token</small></dd></div>
    </dl>
    {quota.legacyRoundEstimate?<p className="hn-usage-caption">早期轮次记录不完整，当前轮次含估计值。</p>:null}
  </details>;
}

export default function UsageStatistics({api,s,busy,ui}:any){
  const {Button,Band,Empty}=ui,[period,setPeriod]=useState<Period>('24h'),[metric,setMetric]=useState('reportedTokens'),result=useUsageRead(api,s.sessionId,period),data:UsageData|null=result.data,overall=data?.overall,unknown=amount(overall?.unknownUsageRequests),pending=amount(overall?.pendingRequests),hasData=!!data;
  const warnings=(data?.warnings??[]).filter((warning:any)=>warning?.count!==0),usageUnavailable=warnings.some((warning:any)=>warning.code==='ATTEMPT_TABLE_UNAVAILABLE'),quotaUnavailable=warnings.some((warning:any)=>warning.code==='SIGNED_LEDGER_UNAVAILABLE');
  return <section className="hn-usage-page" aria-label="用量统计"><style>{css}</style>
    <div className="hn-page-heading"><div><h2>用量统计</h2><p>查看模型消耗，以及哪些工作使用了这些资源。</p></div><Button disabled={busy||result.loading} onClick={result.refresh}>{result.loading?'正在更新…':'刷新统计'}</Button></div>
    <div className="hn-usage-toolbar"><div className="hn-usage-segment" role="group" aria-label="统计时间范围">{([['24h','近 24 小时'],['current-window','当前额度周期']] as [Period,string][]).map(([value,label])=><Button key={value} aria-pressed={period===value} onClick={()=>setPeriod(value)}>{label}</Button>)}</div><p className="hn-usage-updated" role="status">{hasData?<>更新于 {dateTime(data.generatedAt)}{result.error?' · 数据已过期':result.loading?' · 正在刷新':' · 可见时每 30 秒刷新'}</>:result.loading?'正在读取用量…':'尚未读取到用量'}</p></div>
    {data?<p className="hn-usage-range">{windowTime(data.range?.start,data.range?.timeZoneOffsetMinutes,true)}—{windowTime(data.range?.end,data.range?.timeZoneOffsetMinutes,true)} <span>{offsetLabel(data.range?.timeZoneOffsetMinutes)}</span>{period==='current-window'?' · 此周期内的主人沟通与自主工作':''}</p>:null}
    {result.error?<div className="hn-usage-error" role="status">统计读取失败，请稍后刷新。{hasData?'下方保留上次成功读取的数据，不能代表当前用量。':'服务恢复后可以重新读取。'}</div>:null}
    {usageUnavailable||quotaUnavailable?<div className="hn-usage-error" role="status">{usageUnavailable?warningLabels.ATTEMPT_TABLE_UNAVAILABLE:''} {quotaUnavailable?warningLabels.SIGNED_LEDGER_UNAVAILABLE:''}</div>:null}
    {!data?result.loading?<Band>正在读取请求与额度账本，不会调用模型。</Band>:<Empty>暂时无法显示统计。</Empty>:<>
      <div className="hn-usage-metrics">
        <MetricCard label="供应商已报告" value={usageUnavailable?undefined:overall?.reportedTokens} unit="token" detail={usageUnavailable?'请求账本不可读取，无法确认总量。':unknown>0?'仍有用量待确认，实际总消耗尚不确定。':amount(overall?.requests)===0?'该范围尚无分发记录。':'当前范围内已收到的最终用量。'}/>
        <MetricCard label="模型请求" value={usageUnavailable?undefined:overall?.requests} unit="次" detail={usageUnavailable?'请求账本不可读取，无法确认次数。':`主人沟通 ${number(overall?.foregroundRequests)} 次 · 自主工作 ${number(overall?.autonomousRequests)} 次`}/>
        <MetricCard label="保守占额" value={usageUnavailable||quotaUnavailable?undefined:overall?.conservativeTokens} unit="token" detail={usageUnavailable||quotaUnavailable?'额度账本不可读取，暂不能确认占额。':`含未结算预留 ${number(overall?.pendingReservedTokens)} token；不代表实际费用。`}/>
        <MetricCard label="用量待确认" value={usageUnavailable?undefined:overall?.unknownUsageRequests} unit="次请求" tone={unknown>0?'attention':''} detail={usageUnavailable?'请求账本不可读取，无法确认用量状态。':pending>0?`其中 ${number(pending)} 次等待模型完成。`:unknown>0?'请求已分发，供应商未提供完整最终用量。':amount(overall?.requests)===0?'该范围尚无分发记录。':'当前已分发的请求均有最终用量。'}/>
      </div>
      {amount(overall?.partialUsageRequests)>0?<p className="hn-usage-pending-note">另有 {number(overall?.partialUsageRequests)} 次请求保存了 {number(overall?.partialReportedTokens)} token 的中途报告，最终用量尚未确认，未并入“供应商已报告”。</p>:null}
      <section className="hn-usage-panel" aria-label="每小时用量趋势"><div className="hn-usage-section-heading"><div><h3>每小时趋势</h3><p>等待、失败与取消也可能产生模型消耗。</p></div><div className="hn-usage-segment" role="group" aria-label="趋势指标"><Button aria-pressed={metric==='reportedTokens'} onClick={()=>setMetric('reportedTokens')}>token</Button><Button aria-pressed={metric==='requests'} onClick={()=>setMetric('requests')}>请求次数</Button></div></div>{usageUnavailable?<Empty>请求账本不可读取，暂时无法显示趋势。</Empty>:(data.hourly??[]).length?<HourlyChart rows={data.hourly} offset={data.range?.timeZoneOffsetMinutes} metric={metric}/>:<Empty>当前没有可显示的小时记录。</Empty>}</section>
      <div className="hn-usage-breakdown"><section className="hn-usage-panel" aria-label="工作类别用量"><div className="hn-usage-section-heading"><div><h3>哪些工作消耗了资源</h3><p>展开类别可查看输入、输出、缓存与请求状态。</p></div></div>{usageUnavailable?<Empty>请求账本不可读取，分类用量待确认。</Empty>:<CategoryList rows={data.categories??[]} total={overall?.reportedTokens} ui={ui}/>}<p className="hn-usage-caption">百分比按已报告 token 计算；未确认用量不参与占比。</p></section>
      <section className="hn-usage-panel" aria-label="按模型统计"><div className="hn-usage-section-heading"><div><h3>按模型查看</h3><p>同一模型的各类工作合并计量。</p></div></div>{usageUnavailable?<Empty>请求账本不可读取，模型用量待确认。</Empty>:<ModelList rows={data.models??[]} ui={ui}/>}</section></div>
      <QuotaSummary quota={data.currentQuota} offset={data.range?.timeZoneOffsetMinutes}/>
      <details className="hn-usage-method"><summary>统计口径与注意事项</summary><ul><li>请求次数按本地已分发的模型请求统计；准备后取消另列，不代表供应商收费次数。</li><li>供应商已报告 token 是已知部分。有待确认请求时，不能据此认定实际总消耗。</li><li>保守占额用于准入控制，包括已结算的保守用量及未结算预留；它不是额外消耗，不能与供应商 token 相加。</li><li>每次请求按开始时间和工作类别归属。前后窗口可能因为迟到的供应商回执而更新。</li><li>当前额度周期的总览包含相同时间段的主人沟通与自主工作；单独展开的自主额度账本仅核算自主工作。</li><li>仅统计本 Human 管理的模型调用；外部工具、订阅费与 DSH 其他会话的独立消耗不包含在内。无模型调用的静态提醒或工具操作不会记作模型请求。</li><li>历史记录删除后，完整分类与用量可能无法重建。</li></ul>{warnings.length?<ul className="hn-usage-caption" aria-label="本次数据说明">{warnings.map((warning:any,index:number)=><li key={warning.code??index}>{warningLabels[warning.code]??'部分记录信息不完整，请结合用量待确认数量阅读。'}{amount(warning.count)>0?'（'+number(warning.count)+' 条）':''}</li>)}</ul>:null}</details>
    </>}
  </section>;
}
