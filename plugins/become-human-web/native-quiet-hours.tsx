import React from 'react';

const hourLabel=(hour:number)=>String(hour).padStart(2,'0')+':00';
const hours=Array.from({length:24},(_,hour)=>[hour,hourLabel(hour)]);

export function quietRange(start:number,end:number){
 return start===end?'全天开放':hourLabel(start)+' 至 '+(start>end?'次日 ':'')+hourLabel(end);
}

export function QuietHours({start,end,patch,Select}:any){
 return <div className="hn-field" role="group" aria-label="安静时段"><span>安静时段</span>
  <div className="hn-time-range"><Select aria-label="安静时段开始" value={start} options={hours} onChange={(value:string)=>patch('quietStart',Number(value))}/><span>至</span><Select aria-label="安静时段结束" value={end} options={hours} onChange={(value:string)=>patch('quietEnd',Number(value))}/></div>
  <p className="hn-help">{start===end?'起止时间相同，自主循环全天按设置的间隔检查。':'这段时间暂停闲时自主循环。结束后恢复检查，跳过的轮次不会补跑。'}你发来的消息和已设提醒照常处理。</p>
 </div>;
}
