import {quietOffset,quietUntil} from './quiet-hours.mjs';

// Both the native panel and IM display this worker-side interpretation.
export function runStatus(state,now=Date.now()){
  const {autonomy={},desired,retiring}=state,settings=autonomy.settings??{};
  const online=desired==='running'&&!retiring;
  const quietEnd=quietUntil(settings,now);
  const chat=retiring?'会话维护中':!online?'聊天处理已暂停':state.activeLane==='foreground'?'正在回复':'聊天在线';
  let activity,next=null;
  if(!online)activity='自主循环已停止';
  else if(autonomy.paused||autonomy.error)activity=autonomy.error?'自主保护暂停（'+autonomy.error+'）':'自主已手动暂停';
  else if(!settings.enabled)activity='自主未开启';
  else{
    next=quietEnd??(state.nextTickAt>0?state.nextTickAt:null);
    const retryAt=autonomy.modelRetryAt;
    if(retryAt>now){
      const earliest=Math.max(retryAt,next??0);
      next=quietUntil(settings,earliest)??earliest;
    }
    if(quietEnd!==null)activity='安静时段';
    else if(autonomy.pendingBudgetRequest)activity='自主等待补额';
    else if(state.activeLane&&state.activeLane!=='foreground')activity='正在处理任务';
    else if(retryAt>now)activity='模型暂时未完成，下次自动检查';
    else activity='自主待机';
  }
  const offset=next===null?0:quietOffset(settings,next);
  const nextLabel=next!==null?new Date(next+offset*60000).toISOString().slice(5,16).replace('T',' '):null;
  const nextHint=autonomy.modelRetryAt>now?'最早再试 ':'下次检查 ';
  return {chat,activity,nextCheckAt:next,text:[chat,activity,...(nextLabel?[nextHint+nextLabel]:[])].join(' · ')};
}
