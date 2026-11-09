import {useEffect,useRef,useState} from 'react';
import {useDraftNavigation} from './native-shell';

export function useLocationValue(key:string,initial:string,allowed?:string[]){
  const read=()=>{const value=new URL(location.href).searchParams.get(key);return value&&(!allowed||allowed.includes(value))?value:initial;};
  const [value,setValue]=useState(read);
  useEffect(()=>{const sync=()=>setValue(read());window.addEventListener('human-location',sync);return ()=>window.removeEventListener('human-location',sync);},[key,initial]);
  const update=(next:string)=>{
    if(allowed&&!allowed.includes(next))return;
    const url=new URL(location.href);url.searchParams.set('human','1');url.searchParams.set(key,next);
    if(url.href!==location.href){history.pushState({...history.state,humanIndex:(history.state?.humanIndex??0)+1},'',url);window.dispatchEvent(new Event('human-location'));}
    setValue(next);
  };
  return [value,update] as const;
}

// One listener per Human panel. Back/forward follows the same draft protection
// as clicks; cancelling keeps both the visible page and address unchanged.
export function useLocationHistory(){
  const navigation=useDraftNavigation(),current=useRef({url:location.href,index:history.state?.humanIndex??0}),guard=useRef(navigation);guard.current=navigation;
  useEffect(()=>{
    if(history.state?.humanIndex===undefined)history.replaceState({...history.state,humanIndex:0},'',location.href);
    let restoring=false,accept=false,delta=0;
    const changed=()=>{current.current={url:location.href,index:history.state?.humanIndex??0};};
    const pop=()=>{
      if(restoring){restoring=false;if(accept)history.go(-delta);return;}
      if(accept){accept=false;window.dispatchEvent(new Event('human-location'));return;}
      if(!guard.current.dirty){window.dispatchEvent(new Event('human-location'));return;}
      const target=location.href;delta=current.current.index-(history.state?.humanIndex??current.current.index);
      if(delta){restoring=true;history.go(delta);guard.current.navigate(()=>{accept=true;if(!restoring)history.go(-delta);});}
      else{history.replaceState(history.state,'',current.current.url);guard.current.navigate(()=>{history.replaceState(history.state,'',target);window.dispatchEvent(new Event('human-location'));});}
    };
    window.addEventListener('human-location',changed);window.addEventListener('popstate',pop);
    return ()=>{window.removeEventListener('human-location',changed);window.removeEventListener('popstate',pop);};
  },[]);
}
