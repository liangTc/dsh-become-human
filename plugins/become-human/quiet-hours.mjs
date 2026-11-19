export const defaultQuietHours=Object.freeze({quietStart:22,quietEnd:8});

// A Human uses one quiet-hours zone at a time. Reuse Intl's zone rules per process.
let cachedZone,formatter;
export function zoneOffsetMinutes(zone,instant){
  if(typeof zone!=='string'||!zone.trim()||zone.length>100)throw new Error('INVALID_QUIET_TIME_ZONE');
  if(zone!==cachedZone){
    try{formatter=new Intl.DateTimeFormat('en',{timeZone:zone,timeZoneName:'longOffset'});}
    catch{throw new Error('INVALID_QUIET_TIME_ZONE');}
    cachedZone=zone;
  }
  const label=formatter.formatToParts(instant).find(part=>part.type==='timeZoneName').value;
  if(label==='GMT')return 0;
  const match=/^GMT([+-])(\d{2}):(\d{2})$/.exec(label);
  if(!match)throw new Error('INVALID_QUIET_TIME_ZONE');
  return (match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]));
}

export function quietOffset(settings,at){
  return settings.quietTimeZone?zoneOffsetMinutes(settings.quietTimeZone,at):settings.timeZoneOffsetMinutes??0;
}

function endWithOffset(start,end,offset,now){
  if(start===end)return null;
  const local=new Date(now+offset*60000),hour=local.getUTCHours();
  const quiet=start<end?hour>=start&&hour<end:hour>=start||hour<end;
  if(!quiet)return null;
  if(start>end&&hour>=start)local.setUTCDate(local.getUTCDate()+1);
  local.setUTCHours(end,0,0,0);
  return local.getTime()-offset*60000;
}

// A skipped or repeated local hour can change the answer before the projected end.
export function quietUntil(settings,now=Date.now()){
  const {quietStart,quietEnd,quietTimeZone}=settings;
  let cursor=now;
  while(true){
    const offset=quietOffset(settings,cursor);
    const end=endWithOffset(quietStart,quietEnd,offset,cursor);
    if(end===null)return cursor===now?null:cursor;
    if(!quietTimeZone||quietOffset(settings,end)===offset)return end;
    let before=cursor,after=end;
    while(after-before>1){
      const mid=before+Math.floor((after-before)/2);
      if(quietOffset(settings,mid)===offset)before=mid;else after=mid;
    }
    cursor=after;
  }
}
