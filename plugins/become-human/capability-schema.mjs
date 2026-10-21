const fail=()=>{throw new Error('INVALID_TOOL_INPUT');};
const badSchema=()=>{throw new Error('INVALID_CAPABILITY_SCHEMA');};
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
export const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const unsafeKey=key=>['__proto__','prototype','constructor'].includes(key);
const common=['type','title','description','default','enum'];
const keywords={
  object:new Set([...common,'properties','required','additionalProperties']),
  array:new Set([...common,'items','minItems','maxItems']),
  string:new Set([...common,'minLength','maxLength','format']),
  integer:new Set([...common,'minimum','maximum']),
  number:new Set([...common,'minimum','maximum']),
  boolean:new Set(common),
};

// This is an intentionally bounded JSON Schema subset. Unsupported keywords
// (including pattern, oneOf, $ref and additionalProperties:true) fail at adapter
// registration instead of silently promising constraints we do not enforce.
// Defaults describe the interface only; omitted arguments are not auto-filled.
export function validateCapabilityInput(schema,value,depth=0){
  return normalize(schema,value,depth);
}
function normalize(schema,value,depth,skipEnum=false){
  if(depth>8||!plain(schema))fail();
  let output;
  switch(schema.type){
    case 'object':{
      if(!plain(value)||Object.keys(value).length>40)fail();
      const properties=schema.properties??{};output={};
      if(Object.keys(value).some(key=>unsafeKey(key)||!own(properties,key)))fail();
      if((schema.required??[]).some(key=>!own(value,key)))fail();
      // Stable property order also makes durable request-id hashes independent
      // of the order chosen by a model or a JSON request serializer.
      for(const key of Object.keys(properties))if(own(value,key))output[key]=normalize(properties[key],value[key],depth+1);
      break;
    }
    case 'array':
      if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??40))fail();
      output=Array.from(value,item=>normalize(schema.items,item,depth+1));break;
    case 'string':
      if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??4096)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))fail();
      if(schema.format!==undefined){
        if(schema.format!=='uri'||value!==value.trim()||/[\r\n\t]/u.test(value))fail();
        try{new URL(value);}catch{fail();}
        // Scheme, public-address and credential restrictions belong to the
        // adapter. A syntactically valid URL alone never grants network access.
      }
      output=value;break;
    case 'integer':
      if(!Number.isSafeInteger(value)||value<(schema.minimum??Number.MIN_SAFE_INTEGER)||value>(schema.maximum??Number.MAX_SAFE_INTEGER))fail();
      output=value;break;
    case 'number':
      if(!Number.isFinite(value)||value<(schema.minimum??-Number.MAX_VALUE)||value>(schema.maximum??Number.MAX_VALUE))fail();
      output=value;break;
    case 'boolean':
      if(typeof value!=='boolean')fail();output=value;break;
    default:fail();
  }
  if(!skipEnum&&schema.enum!==undefined){
    if(!Array.isArray(schema.enum)||!schema.enum.some(item=>JSON.stringify(normalize(schema,item,depth,true))===JSON.stringify(output)))fail();
  }
  return output;
}

export function assertCapabilitySchema(schema,depth=0){
  if(depth>8||!plain(schema)||!own(keywords,schema.type)||Object.keys(schema).some(key=>!keywords[schema.type].has(key)))badSchema();
  if(own(schema,'title')&&(typeof schema.title!=='string'||schema.title.length>256)||own(schema,'description')&&(typeof schema.description!=='string'||schema.description.length>8192))badSchema();
  const bound=(key,{integer=false,min=-Number.MAX_VALUE,max=Number.MAX_VALUE}={})=>{
    if(!own(schema,key))return;
    const value=schema[key];
    if(!Number.isFinite(value)||integer&&!Number.isSafeInteger(value)||value<min||value>max)badSchema();
  };
  if(schema.type==='object'){
    const properties=schema.properties??{};
    if(own(schema,'properties')&&!plain(schema.properties)||!plain(properties)||Object.keys(properties).length>40||own(schema,'additionalProperties')&&schema.additionalProperties!==false)badSchema();
    for(const [key,value] of Object.entries(properties)){
      if(!key.length||key.length>100||unsafeKey(key))badSchema();assertCapabilitySchema(value,depth+1);
    }
    const required=schema.required??[];
    if(own(schema,'required')&&!Array.isArray(schema.required)||!Array.isArray(required)||required.length>40||new Set(required).size!==required.length||required.some(key=>typeof key!=='string'||!own(properties,key)))badSchema();
  }
  if(schema.type==='array'){
    assertCapabilitySchema(schema.items,depth+1);bound('minItems',{integer:true,min:0,max:256});bound('maxItems',{integer:true,min:0,max:256});
    if((schema.minItems??0)>(schema.maxItems??40))badSchema();
  }
  if(schema.type==='string'){
    bound('minLength',{integer:true,min:0,max:65536});bound('maxLength',{integer:true,min:0,max:65536});
    if((schema.minLength??0)>(schema.maxLength??4096)||own(schema,'format')&&schema.format!=='uri')badSchema();
  }
  if(schema.type==='integer'||schema.type==='number'){
    const options=schema.type==='integer'?{integer:true,min:Number.MIN_SAFE_INTEGER,max:Number.MAX_SAFE_INTEGER}:{};
    bound('minimum',options);bound('maximum',options);if((schema.minimum??-Infinity)>(schema.maximum??Infinity))badSchema();
  }
  if(own(schema,'enum')){
    if(!Array.isArray(schema.enum)||!schema.enum.length||schema.enum.length>64)badSchema();
    const normalized=[];
    for(const value of schema.enum){let item;try{item=JSON.stringify(normalize(schema,value,depth,true));}catch{badSchema();}if(normalized.includes(item))badSchema();normalized.push(item);}
  }
  if(own(schema,'default')){try{normalize(schema,schema.default,depth);}catch{badSchema();}}
  try{if(Buffer.byteLength(JSON.stringify(schema))>16384)badSchema();}catch{badSchema();}
}
