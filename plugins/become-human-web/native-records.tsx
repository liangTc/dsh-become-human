import React from 'react';
import {readableRecord,userRecord,recordLabels,recordValue} from './record-presentation.mjs';
function Fields({value,exact=false}:any){
 if(value===null||value===undefined)return null;
 if(typeof value!=='object')return <p className="hn-record-text">{recordValue(value)}</p>;
 if(Array.isArray(value))return <ul className="hn-record-list">{value.map((v,i)=><li key={i}><Fields value={v} exact={exact}/></li>)}</ul>;
 return <dl className="hn-record-fields">{Object.entries(value).map(([key,v])=><div key={key}><dt>{exact?(recordLabels[key]??key):key}</dt><dd><Fields value={v} exact={exact}/></dd></div>)}</dl>;
}
export function RecordContent({value,sanitize=true}:any){const content=sanitize?userRecord(readableRecord(value)):value;return <Fields value={content} exact={!sanitize}/>;}
export default function RecordDetails({value,label='内容详情'}:any){const content=userRecord(readableRecord(value));return content===null?null:<details className="hn-record-details"><summary>{label}</summary><div className="hn-record-content"><Fields value={content}/></div></details>;}
