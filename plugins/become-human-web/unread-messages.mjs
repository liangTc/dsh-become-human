const visibleMessage = row => ['assistant','budget-request'].includes(row?.kind)
  && Number.isSafeInteger(row.seq) && row.seq > 0 && !!String(row.displayText ?? row.text ?? '').trim();
export class UnreadMessages {
  constructor(storage){this.storage=storage;this.seen=new Map();this.session=null;this.rows=[];}
  key(session){return 'become-human:read:'+session;}
  update(state){
    if(!state?.sessionId || !Array.isArray(state.messages))return this.unread;
    this.session=state.sessionId;this.rows=state.messages.filter(visibleMessage);
    if(!this.seen.has(this.session)){
      let saved=null;try{saved=this.storage?.getItem(this.key(this.session));}catch{}
      const value=saved===null?NaN:Number(saved);
      this.seen.set(this.session,Number.isSafeInteger(value)&&value>=0?value:this.latest);
      this.persist();
    }
    return this.unread;
  }
  get latest(){return this.rows.reduce((max,row)=>Math.max(max,row.seq),0);}
  get unread(){return !!this.session && this.rows.some(row=>row.seq>(this.seen.get(this.session)??0));}
  read(session,through){
    if(session!==this.session || !Number.isSafeInteger(through) || through<0)return this.unread;
    this.seen.set(session,Math.max(this.seen.get(session)??0,Math.min(through,this.latest)));
    this.persist();return this.unread;
  }
  persist(){try{this.storage?.setItem(this.key(this.session),String(this.seen.get(this.session)));}catch{}}
}
