const parse=s=>{try{return JSON.parse(s);}catch{return {};}};
const clean=value=>{if(typeof value==='string')return value.replace(/([?&](?:token|api_key|access_token)=)[^\s&]+/gi,'$1[REDACTED]').replace(/sk-[\w-]{16,}/g,'[REDACTED]').slice(0,2000);if(Array.isArray(value))return value.slice(0,30).map(clean);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['messages','text','payload','body','content','apiKey','token','password','headers'].includes(k)).map(([k,v])=>[k,clean(v)]));return value;};
function classify(kind,d){return /delivery/.test(kind)?'delivery':/^action-|^goal-report-/.test(kind)?'action':/skill/.test(kind)?'skill':/memory|learning|note/.test(kind)?'learning':/timer|wait/.test(kind)?'wake':/attempt|dispatch/.test(kind)?'model':/task|autonomy|social|goal/.test(kind)?'task':/message|published/.test(kind)?'message':/grant|config|profile|control|persona/.test(kind)?'configuration':'system';}
export class EventLog {
  constructor(db,prefix='r'){this.db=db;this.prefix=prefix;db.exec(`CREATE TABLE IF NOT EXISTS human_event(agent TEXT,id TEXT,time INTEGER,type TEXT,kind TEXT,status TEXT,origin TEXT,lane TEXT,task_id TEXT,round_id TEXT,request_id TEXT,data TEXT,search TEXT,PRIMARY KEY(agent,id));CREATE INDEX IF NOT EXISTS human_event_time ON human_event(agent,time DESC,id DESC);CREATE INDEX IF NOT EXISTS human_event_task ON human_event(agent,task_id,time);`);}
  append(agent,key,kind,data={}){
    const d=clean(data),time=Number.isSafeInteger(d.time)?d.time:Date.now(),type=d.type??classify(kind,d),status=(/^action-/.test(kind)?({proposed:'wait',approved:'wait',executing:'running',completed:'success',blocked:'failed',expired:'failed',cancelled:'suspended'})[d.status]:undefined)??d.status??(/suspend|preempt|cancel/.test(kind)?'suspended':/fail|reject|error|interrupted/.test(kind)||d.code||d.error?'failed':/wait|defer/.test(kind)?'wait':/executing|dispatch|prepared|running/.test(kind)?'running':'success'),id=this.prefix+':'+key,origin=d.origin??(d.lane==='foreground'?'owner':/timer|autonomy|task|learning/.test(kind)?'timer':'system'),payload=JSON.stringify(d);
    this.db.prepare('INSERT OR IGNORE INTO human_event VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(agent,id,time,type,kind,status,origin,d.lane??'',d.taskId??null,d.roundId??d.taskId??null,d.attemptId??d.requestId??null,payload,(kind+' '+payload).toLowerCase());
  }
  query(agent,input={}){
    const limit=Number(input.limit??25);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_LOG_LIMIT');
    const clauses=['agent=?'],params=[agent];
    for(const [key,column] of [['type','type'],['status','status'],['origin','origin'],['lane','lane'],['taskId','task_id']])if(input[key]){if(typeof input[key]!=='string'||input[key].length>100)throw new Error('INVALID_LOG_FILTER');clauses.push(column+'=?');params.push(input[key]);}
    for(const [key,operator] of [['from','>='],['to','<=']])if(input[key]!==undefined&&input[key]!==''){const value=Number(input[key]);if(!Number.isSafeInteger(value)||value<0)throw new Error('INVALID_LOG_TIME');clauses.push('time'+operator+'?');params.push(value);}
    if(input.query){if(typeof input.query!=='string'||input.query.length>160)throw new Error('INVALID_LOG_QUERY');clauses.push('instr(search,?)>0');params.push(input.query.toLowerCase());}
    const base=clauses.join(' AND '),total=this.db.prepare('SELECT count(*) AS n FROM human_event WHERE '+base).get(...params).n;
    if(input.before!==undefined&&input.before!==''){const before=Number(input.before),beforeId=input.beforeId??'\uffff';if(!Number.isSafeInteger(before)||typeof beforeId!=='string'||beforeId.length>160)throw new Error('INVALID_LOG_CURSOR');clauses.push('(time<? OR time=? AND id<?)');params.push(before,before,beforeId);}
    const rows=this.db.prepare('SELECT * FROM human_event WHERE '+clauses.join(' AND ')+' ORDER BY time DESC,id DESC LIMIT ?').all(...params,limit+1);
    const items=rows.slice(0,limit).map(({data,search,task_id,round_id,request_id,...r})=>({...r,title:r.kind,taskId:task_id,roundId:round_id,requestId:request_id,data:parse(data)})),last=items.at(-1);
    return {total,items,hasMore:rows.length>limit,next:last?{before:last.time,beforeId:last.id}:null};
  }
  task(agent,id){return this.db.prepare('SELECT id,time,kind,status,lane,data,request_id FROM human_event WHERE agent=? AND task_id=? ORDER BY time,id LIMIT 10000').all(agent,id).map(({data,request_id,...r})=>({...r,requestId:request_id,data:parse(data)}));}
  prune(agent,days){this.db.prepare('DELETE FROM human_event WHERE agent=? AND time<?').run(agent,Date.now()-days*86400000);}
}
