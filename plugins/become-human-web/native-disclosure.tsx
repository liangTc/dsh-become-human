import React,{useEffect,useRef,useState} from 'react';

export type DisclosureState={scope:string;open:Record<string,boolean>};
export const createDisclosureState=(scope:string):DisclosureState=>({scope,open:{}});
export const disclosureIsOpen=(state:DisclosureState,scope:string,id:string)=>state.scope===scope&&state.open[id]===true;
export function updateDisclosures(state:DisclosureState,scope:string,ids:string[],open:boolean):DisclosureState{
  const previous=state.scope===scope?state.open:{};
  if(state.scope===scope&&ids.every(id=>(previous[id]===true)===open))return state;
  const next={...previous};for(const id of ids)if(open)next[id]=true;else delete next[id];
  return {scope,open:next};
}

// A page/Session change starts closed. Refresh timestamps are deliberately not
// part of the scope, so polling does not reset the user's reading position.
export function useDisclosure(scope:string){
  const [state,setState]=useState(()=>createDisclosureState(scope)),currentScope=useRef(scope);currentScope.current=scope;
  if(state.scope!==scope)setState(createDisclosureState(scope));
  return {isOpen:(id:string)=>disclosureIsOpen(state,scope,id),setOpen:(id:string,open:boolean)=>setState(previous=>currentScope.current===scope?updateDisclosures(previous,scope,[id],open):previous),setAll:(ids:string[],open:boolean)=>setState(previous=>currentScope.current===scope?updateDisclosures(previous,scope,ids,open):previous)};
}

// Preserve mounted nodes while the same view refreshes. Changing Session or
// page scope still hides the previous data immediately.
export function useRetainedRead(api:any,input:any,nonce=0,viewScope?:string){
  const requestKey=JSON.stringify(input),sessionId=api.snapshot?.state?.sessionId??'',scope=JSON.stringify([sessionId,viewScope??requestKey]);
  const [result,setResult]=useState<any>({scope,data:null,error:'',loading:true});
  useEffect(()=>{
    let live=true;
    setResult((old:any)=>({scope,data:old.scope===scope?old.data:null,error:'',loading:true}));
    api.read(input).then((data:any)=>{if(live)setResult({scope,data,error:'',loading:false});}).catch((error:any)=>{if(live)setResult((old:any)=>({scope,data:old.scope===scope?old.data:null,error:error.message??'读取失败',loading:false}));});
    return ()=>{live=false;};
  },[api,requestKey,scope,nonce]);
  return result.scope===scope?result:{scope,data:null,error:'',loading:true};
}

export function DisclosureChevron(){return <svg className="hn-disclosure-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>;}
