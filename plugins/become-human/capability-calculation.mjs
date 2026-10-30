import {plain} from './capability-schema.mjs';

const fail=code=>{throw new Error(code);};
const abs=x=>x<0n?-x:x;
const gcd=(a,b)=>{a=abs(a);b=abs(b);while(b){const next=a%b;a=b;b=next;}return a;};
function fraction(n,d){
  if(d===0n)fail('CALCULATION_DIVISION_BY_ZERO');
  if(d<0n){n=-n;d=-d;}const g=gcd(n,d);n/=g;d/=g;
  if(abs(n).toString().length>512||d.toString().length>512)fail('CALCULATION_TOO_LARGE');
  return {n,d};
}
function parse(text){
  if(typeof text!=='string'||text!==text.trim()||!/^(-?(?:0|[1-9]\d{0,23})(?:\.\d{1,12})?)$/u.test(text))fail('INVALID_CALCULATION_NUMBER');
  const negative=text.startsWith('-'),[whole,decimal='']=text.replace(/^-/u,'').split('.');
  return fraction(BigInt(whole+decimal)*(negative?-1n:1n),10n**BigInt(decimal.length));
}
export const calculationSchema={type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:['sum','subtract','multiply','divide']},values:{type:'array',items:{type:'string',minLength:1,maxLength:48},minItems:1,maxItems:100},precision:{type:'integer',minimum:0,maximum:12}},required:['operation','values']};
export function calculateNumbers(input){
  if(!plain(input)||Object.keys(input).some(k=>!['operation','values','precision'].includes(k))||!['sum','subtract','multiply','divide'].includes(input.operation)||!Array.isArray(input.values)||input.values.length<1||input.values.length>100)fail('INVALID_CALCULATION_INPUT');
  const precision=input.precision??12;if(!Number.isSafeInteger(precision)||precision<0||precision>12)fail('INVALID_CALCULATION_INPUT');
  const values=input.values.map(parse);if(['subtract','divide'].includes(input.operation)&&values.length<2)fail('INVALID_CALCULATION_INPUT');
  let value=values[0];
  for(const item of values.slice(1)){
    if(input.operation==='sum')value=fraction(value.n*item.d+item.n*value.d,value.d*item.d);
    if(input.operation==='subtract')value=fraction(value.n*item.d-item.n*value.d,value.d*item.d);
    if(input.operation==='multiply')value=fraction(value.n*item.n,value.d*item.d);
    if(input.operation==='divide')value=fraction(value.n*item.d,value.d*item.n);
  }
  const scale=10n**BigInt(precision),scaled=abs(value.n)*scale,remainder=scaled%value.d;
  let units=scaled/value.d;if(remainder*2n>=value.d)units++;
  const digits=units.toString().padStart(precision+1,'0'),body=precision?(digits.slice(0,-precision)+'.'+digits.slice(-precision)).replace(/\.?0+$/u,''):digits;
  return {operation:input.operation,values:[...input.values],exact:{numerator:value.n.toString(),denominator:value.d.toString()},decimal:(value.n<0n&&units!==0n?'-':'')+body,precision,rounded:remainder!==0n,rounding:'half-away-from-zero',inputValuesVerified:false,scope:'Arithmetic of the supplied decimal values only; does not verify OCR, units, source truth or missing rows.'};
}
export function registerCalculationCapability(registry){
  return registry.register('calculate-numbers',{title:'数值计算',description:'对已经读取或从图片识别出的十进制数值进行求和、依次相减、相乘或依次相除。values逐项使用原始数值字符串，不带逗号、单位、公式或代码；结果保留精确分数与有界小数。计算不证明原始数值识别正确。',version:1,inputSchema:calculationSchema,effect:'read',backend:'local-calculation',scope:'supplied-numbers-only',timeoutMs:1000,maxResultBytes:16384,retrySafe:true,autonomous:false,execute:async input=>calculateNumbers(input)});
}
