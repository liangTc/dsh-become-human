import React,{useEffect,useRef} from 'react';

// Dialog chrome never scrolls. A nested image/detail owns keyboard focus until closed.
export default function Detail({title,onClose,children}:any){
 const ref=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement;ref.current?.querySelector<HTMLElement>('button')?.focus();return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
 return <div className="hn-modal" role="presentation"><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className="hn-dialog" onKeyDown={event=>{
   if((event.target as HTMLElement).closest('[role="dialog"]')!==ref.current)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();}
   if(event.key==='Tab'){
    const controls=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')??[]).filter(el=>el.getClientRects().length>0&&el.closest('[role="dialog"]')===ref.current),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
   }
 }}><header className="hn-dialog-header"><div><h3>{title}</h3></div><button type="button" className="hn-button" onClick={onClose} title="关闭（Esc）">关闭 <span aria-hidden="true">×</span></button></header><div className="hn-dialog-body">{children}</div></section></div>;
}
