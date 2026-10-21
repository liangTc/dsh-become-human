// A finite grammar for direct owner requests. It returns a proposal only;
// authentication, idempotency, persistence and delivery stay in ReminderStore.
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const numeral='(?:\\d{1,4}|[零〇一二三四五六七八九十两]{1,4})';
const secret=/(?:sk-[\w-]{16,}|(?:api.?key|password|密码|令牌|token)\s*[:=]\s*\S{8,})/iu;
const clarify=(reason,text)=>({op:'clarify',reason,text});
const missingTime=()=>clarify('missing-time','请给出明确的提醒时间，例如“明天下午三点提醒我喝水”。');
const invalidTime=()=>clarify('invalid-time','这个日期或时间无法确定，请用明确日期和24小时制时间重新说明。');
const multiple=()=>clarify('multiple-intents','这条消息包含多个时间或操作，请每条消息只安排一个提醒。');
const fold=value=>value.replace(/[０-９：]/gu,char=>char==='：'?':':String.fromCharCode(char.charCodeAt(0)-0xfee0));
const clip=(value,max)=>{let result=value.slice(0,max);if(/[\uD800-\uDBFF]$/u.test(result))result=result.slice(0,-1);return result;};
function number(value){
  if(/^\d+$/u.test(value))return Number(value);
  const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(Object.hasOwn(digits,value))return digits[value];
  const match=/^([一二三四五六七八九两])?十([一二三四五六七八九])?$/u.exec(value);
  return match?(match[1]?digits[match[1]]:1)*10+(match[2]?digits[match[2]]:0):null;
}
function polite(value){
  let body=value.trim();for(let i=0;i<4;i++){const next=body.replace(/^(?:请你|麻烦你|请|麻烦|帮我|给我)\s*/u,'');if(next===body)break;body=next;}return body;
}
function framed(value){
  return /^(?:["'“‘「『`>]|例如|比如|假如|假设|如果|示例|样例|引用|转述|测试(?:句子|语句|文本|指令|例子)|(?:他|她|别人|有人|用户)(?:说|问)|(?:请|帮我)?(?:翻译|改写|解释|分析|总结|评价|检查|验证).{0,16}(?:这句|下面|句子|文本|语句|指令))/u.test(value);
}
function fixedZone(offset){return offset%60===0?(offset===0?'UTC':'Etc/GMT'+(offset>0?'-':'+')+Math.abs(offset/60)):null;}
function clockPrefix(body,impliedPeriod=''){
  const prefix=/^(上午|早上|早晨|下午|晚上|中午|凌晨)?\s*/u.exec(body),period=prefix[1]??impliedPeriod,start=prefix[0].length,rest=body.slice(start);
  const colon=/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/u.exec(rest);
  const chinese=!colon?new RegExp('^('+numeral+')\\s*(?:点|时)(半|(?:'+numeral+')\\s*分)?','u').exec(rest):null;
  if(!colon&&!chinese)return {error:'missing-time'};
  const match=colon??chinese,hour=colon?Number(match[1]):number(match[1]);
  let minute=colon?Number(match[2]):match[2]==='半'?30:match[2]?number(match[2].replace(/\s*分$/u,'')):0,second=colon?Number(match[3]??0):0,h=hour;
  if(h===null||minute===null||h<0||h>23||minute<0||minute>59||second>59||/^[:：点时分秒刻半]/u.test(rest.slice(match[0].length)))return {error:'invalid-time'};
  if(period){
    if(h>12){if(period==='下午'&&h<=18||period==='晚上'&&h>=18||period==='中午'&&h<=14){}else return {error:'invalid-time'};}
    else if(['上午','早上','早晨'].includes(period)){if(h===12)return {error:'ambiguous-period'};}
    else if(period==='凌晨'){if(h===12)h=0;if(h>6)return {error:'ambiguous-period'};}
    else if(period==='中午'){if(h===11||h===12){}else if(h>=1&&h<=2)h+=12;else return {error:'ambiguous-period'};}
    else if(period==='下午'){if(h===0)return {error:'ambiguous-period'};if(h!==12)h+=12;}
    else if(period==='晚上'){if(h===0||h===12)return {error:'ambiguous-period'};h+=12;if(h<18)return {error:'ambiguous-period'};}
  }else if(!colon)return {error:'ambiguous-period'};
  return {length:start+match[0].length,hour:h,minute,second,time:String(h).padStart(2,'0')+':'+String(minute).padStart(2,'0')+(second?':'+String(second).padStart(2,'0'):'')};
}
function temporalPrefix(input,now,offset){
  const lead=/^(?:在\s*)?/u.exec(input)[0].length,body=input.slice(lead);
  const relative=new RegExp('^('+numeral+')(?:\\s*)(分钟|分|个小时|小时)(?:以后|之后|后)','u').exec(body);
  const half=/^半(?:个)?小时(?:以后|之后|后)/u.exec(body);
  if(relative||half){const n=half?0.5:number(relative[1]),unit=half?'小时':relative[2];if(n===null||n<=0)return {error:'invalid-time'};const delta=n*(unit.includes('小时')?3600000:60000),dueAt=now+delta;if(!Number.isSafeInteger(dueAt)||!Number.isFinite(new Date(dueAt).getTime()))return {error:'invalid-time'};return {length:lead+(half??relative)[0].length,rule:{kind:'at',at:new Date(dueAt).toISOString()},dueAt};}
  const date=/^(?:(\d{4})-(\d{2})-(\d{2})(?:T|\s+|(?=上午|早上|早晨|下午|晚上|中午|凌晨))|(今天|明天|后天|昨天|前天|今晚)|(每天)|每(?:周|星期)([一二三四五六日天1-7]))\s*/u.exec(body);
  if(!date){if(/^(?:每|隔|下周|下星期|这周|周末|工作日|\d{1,2}月|上午|下午|晚上|凌晨|\d{1,2}:)/u.test(body))return {error:'ambiguous-date-or-cycle'};return {error:'missing-time'};}
  const time=clockPrefix(body.slice(date[0].length),date[4]==='今晚'?'晚上':'');if(time.error)return time;
  const length=lead+date[0].length+time.length;
  if(date[5]||date[6]){const timeZone=fixedZone(offset);if(!timeZone)return {error:'unsupported-recurring-timezone'};if(time.second)return {error:'unsupported-cycle'};const canonicalTime=time.time.length===5?time.time+':00':time.time;return {length,rule:date[5]?{kind:'daily',time:canonicalTime,timeZone}:{kind:'weekly',time:canonicalTime,timeZone,weekdays:[{一:1,二:2,三:3,四:4,五:5,六:6,日:7,天:7}[date[6]]??Number(date[6])]}};}
  const local=new Date(now+offset*60000),base=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());let y,m,d;
  if(date[1]){[y,m,d]=date.slice(1,4).map(Number);if(y<1970||y>9999)return {error:'invalid-time'};}
  else {const day=new Date(base+({今天:0,明天:1,后天:2,昨天:-1,前天:-2,今晚:0}[date[4]])*86400000);y=day.getUTCFullYear();m=day.getUTCMonth()+1;d=day.getUTCDate();}
  const instant=Date.UTC(y,m-1,d,time.hour,time.minute,time.second),check=new Date(instant);
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d)return {error:'invalid-time'};
  const dueAt=instant-offset*60000;return {length,rule:{kind:'at',at:new Date(dueAt).toISOString()},dueAt};
}
function timeClarification(reason){
  if(reason==='missing-time')return missingTime();
  if(reason==='ambiguous-period')return clarify(reason,'请说明上午、下午或晚上，或使用24小时制，例如“明天15:00”。午夜请给出明确日期与00:00。');
  if(reason==='unsupported-recurring-timezone')return clarify(reason,'当前固定时区偏移包含半小时或分钟，周期提醒请在定时任务面板指定准确时区。');
  if(reason==='ambiguous-date-or-cycle'||reason==='unsupported-cycle')return clarify(reason,'请给出一个明确日期，或“每天HH:mm”“每周一HH:mm”这样的单一周期。');
  return invalidTime();
}
export function parseScheduleIntent(text,{now=Date.now(),timeZoneOffsetMinutes=480,directOwner=true}={}){
  if(directOwner!==true||typeof text!=='string'||!text.trim()||/^\s*\//u.test(text))return null;
  const original=polite(text);if(framed(text.trim())||framed(original))return null;
  const body=fold(original),createVerb=/^(?:(?:提醒我|通知我|叫我)(?:一下)?|(?:设置|创建|添加|登记|安排)(?:一个|一条|个|条)?(?:提醒|定时任务))/u;
  if(/^(?:(?:查看|列出|显示|查询|看看)(?:一下)?(?:我(?:的)?|当前|所有)?(?:提醒|定时任务|自动化任务)(?:列表|有哪些|记录)?|我(?:的)?(?:有哪些|有啥)(?:提醒|定时任务)|(?:提醒|定时任务)列表)[。.!！?？]*$/u.test(body))return {op:'list'};
  const action=/^(取消|暂停|恢复)(?:一下)?(?:提醒|定时任务)(?:编号(?:为)?)?[\s:：]*/u.exec(body);
  if(action){const id=new RegExp('^('+uuid+')[。.!！]*$','u').exec(body.slice(action[0].length));if(!id)return clarify('missing-or-ambiguous-id','请提供需要操作的单个提醒完整编号，例如“取消提醒 完整编号”。');return {op:{取消:'cancel',暂停:'pause',恢复:'resume'}[action[1]],id:id[1].toLowerCase()};}
  if(/^(?:提醒我|通知我)(?:一下)?(?:你是谁|是什么|什么意思|怎么用|之前说过什么)/u.test(body))return null;
  const wrapper=createVerb.exec(body),timeFirst=/^(?:在\s*)?(?:\d|[零〇一二三四五六七八九十两半]|今天|明天|后天|昨天|前天|今晚|每天|每周|每星期|每隔|下周|下星期|工作日|周末|上午|下午|晚上|凌晨)/u.test(body)&&/(?:提醒我|通知我|叫我)/u.test(body);
  if(!wrapper&&!timeFirst)return null;
  if(/(?:这句(?:话)?|这条(?:指令|请求)|这样(?:说|写)).{0,16}(?:是什么意思|什么意思|如何|怎么|能否|是否|可行)|(?:是什么意思|如何实现|怎么实现|能做到吗|能实现吗|做得到吗|可以做到吗|能否实现)[?？。.!！]*$/u.test(body)||/(?:这是|以上是).{0,12}(?:测试句子|例句|示例|引用|转述)|(?:没有真的|不是真的|不需要|不要).{0,8}(?:设置|创建|登记|执行)/u.test(body))return clarify('meta-request','这句话是在讨论提醒功能或引用示例，请直接说明是否要登记提醒及其时间和事项。');
  if(text.length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))return clarify('invalid-input','这条提醒请求过长或含控制字符，请分成一条明确请求。');
  if(!Number.isSafeInteger(now)||!Number.isFinite(new Date(now).getTime())||!Number.isInteger(timeZoneOffsetMinutes)||timeZoneOffsetMinutes< -720||timeZoneOffsetMinutes>840||!Number.isFinite(new Date(now+timeZoneOffsetMinutes*60000).getTime()))return clarify('invalid-time-context','当前时钟或时区配置无效，请先在配置中核对。');
  if((body.match(/提醒我|通知我|叫我/gu)??[]).length>1||/[\r\n]/u.test(body))return multiple();
  let temporalInput,rawInput;
  if(wrapper){let consumed=wrapper[0].length;const separator=/^[\s:：，,]*/u.exec(body.slice(consumed))[0];consumed+=separator.length;temporalInput=body.slice(consumed);rawInput=original.slice(consumed);}
  else {temporalInput=body;rawInput=original;}
  const parsed=temporalPrefix(temporalInput,now,timeZoneOffsetMinutes);if(parsed.error)return timeClarification(parsed.error);
  let rest=temporalInput.slice(parsed.length),rawRest=rawInput.slice(parsed.length);const separator=/^[\s:：，,]*/u.exec(rest)[0];rest=rest.slice(separator.length);rawRest=rawRest.slice(separator.length);
  if(!separator&&/^[零〇一二三四五六七八九十两\d]/u.test(rest))return invalidTime();
  if(/^(?:或|或者|还是|和|以及|与|、|到|至|左右|前后|大概|大约|之前|以后|之后|前|后)/u.test(rest))return clarify('ambiguous-time-range','这条请求使用了备选、范围或大约时间，请指定一个准确的提醒时刻。');
  const reminder=/^(?:再)?(?:提醒我|通知我|叫我)(?:一下)?[\s:：，,]*/u.exec(rest);if(reminder){rest=rest.slice(reminder[0].length);rawRest=rawRest.slice(reminder[0].length);}else if(!wrapper)return clarify('missing-reminder-action','请明确说明要登记提醒，例如“明天15:00提醒我喝水”。');
  if(/^[\s:：，,]*$/u.test(rest))return clarify('missing-content','请说明到点要提醒的具体事项。');
  if(/(?:然后|另外|再|同时|或者|或|还是|和|以及|与|[；;，,、])\s*(?:明天|今天|后天|每天|每周|\d{1,2}:|\d+分钟后|\d+小时后)/u.test(rest)||/^(?:每|隔|以及|和|与|、)/u.test(rest))return multiple();
  const prompt=rawRest.trim().replace(/(?:[，,]\s*)?(?:好吗|好么|可以吗|可以么|行吗)[?？。.!！]*$/u,'').replace(/[。.!！?？]+$/u,'').trim();
  if(!prompt||/^(?:一下|这个|那个|一件事|吧|吗)$/u.test(prompt))return clarify('missing-content','请说明到点要提醒的具体事项。');
  if(prompt.length>2000||secret.test(prompt))return clarify(secret.test(prompt)?'sensitive-content':'content-too-long','提醒内容过长或含凭据，请缩短内容并移除密钥、密码等信息。');
  if(parsed.dueAt!==undefined){if(parsed.dueAt<=now)return clarify('past-time','这个时间已经过去，请提供未来的明确日期和时间。');if(parsed.dueAt<now+30000)return clarify('too-soon','提醒时间须至少在30秒以后，请给出稍晚一些的时间。');if(parsed.dueAt>now+366*86400000)return clarify('time-out-of-range','请将一次性提醒设在未来366天以内。');}
  return {op:'create',schedule:{title:clip(prompt,120),prompt,mode:'notify',latePolicy:'skip',rule:parsed.rule},...(parsed.dueAt!==undefined?{dueAt:parsed.dueAt}:{})};
}
