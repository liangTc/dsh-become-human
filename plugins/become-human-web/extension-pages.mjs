const fail=()=>{throw Error('EXTENSION_PAGE_INVALID');};
const text=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail();return value;};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
// v1 remains pure data. v2 explicitly opts into trusted, bundled React code.
export function extensionPages(manifest,nodes){
  const pages=manifest.dsh?.human?.pages;if(pages===undefined)return [];
  if(!Array.isArray(pages)||pages.length>8)fail();
  const ids=new Set();
  return pages.map(page=>{
    if(!object(page)||![1,2].includes(page.version)||typeof page.id!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(page.id)||ids.has(page.id)||!nodes.some(node=>node.id===page.nodeId))fail();ids.add(page.id);
    if(page.version===2){
      if(typeof page.client!=='string'||!/^\.?\/?[a-zA-Z0-9_./-]+\.(?:c?js)$/.test(page.client)||page.client.startsWith('/')||page.client.replace(/^\.\//,'').split('/').some(part=>!part||part==='..'||part==='.')||!Array.isArray(page.methods)||!page.methods.length||page.methods.length>24)fail();
      const names=new Set();const methods=page.methods.map(m=>{if(!object(m)||typeof m.name!=='string'||!/^[a-z][a-z0-9.-]{0,63}$/.test(m.name)||names.has(m.name)||!['read','write'].includes(m.mode))fail();names.add(m.name);return {name:m.name,mode:m.mode,description:text(m.description,300)};});
      return {version:2,id:page.id,nodeId:page.nodeId,title:text(page.title,64),description:page.description===undefined?'':text(page.description,300),client:page.client,methods};
    }
    if(!Array.isArray(page.blocks)||page.blocks.length>24)fail();
    return {id:page.id,version:1,nodeId:page.nodeId,title:text(page.title,64),description:page.description===undefined?'':text(page.description,300),blocks:page.blocks.map(block=>{
      if(!object(block))fail();
      if(block.type==='text')return {type:'text',text:text(block.text,8000)};
      if(block.type==='list'){if(!Array.isArray(block.items)||block.items.length>32)fail();return {type:'list',items:block.items.map(item=>text(item,1000))};}
      if(block.type==='runtime-status')return {type:'runtime-status'};
      fail();
    })};
  });
}
export function activeExtensionPages(items){
  return items.filter(item=>item.manageable&&item.registered).flatMap(item=>(item.pages??[]).filter(page=>item.nodes.some(node=>node.id===page.nodeId&&!node.disabled)).map(page=>({...page,key:item.name+':'+page.id,packageName:item.name,packageVersion:item.version})));
}
