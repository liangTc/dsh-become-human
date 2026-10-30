import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {assertCapabilitySchema,validateCapabilityInput} from '../plugins/become-human/capability-schema.mjs';
import {describeCustomMcpTool,normalizeCustomMcpServer} from '../plugins/become-human/capability-mcp-config.mjs';

const cases=[],test=(name,fn)=>{try{fn();cases.push({name,passed:true});}catch(error){cases.push({name,passed:false,error:error.stack});}};
const schema={type:'object',properties:{query:{type:'string',default:null}}};
test('Optional null default is descriptive metadata and discovery supports the tool',()=>{const d=describeCustomMcpTool({name:'docs_search',inputSchema:schema});assert(d.supported);assert.equal(d.enabled,false);assert.equal(d.effect,'write');assert.equal(d.inputSchema.properties.query.default,null);});
test('Missing optional value is not filled with the null annotation',()=>{assertCapabilitySchema(schema);assert.deepEqual(validateCapabilityInput(schema,{}),{});});
test('An actual null input still fails its string constraint',()=>assert.throws(()=>validateCapabilityInput(schema,{query:null}),/INVALID_TOOL_INPUT/));
test('Required properties stay required despite a default annotation',()=>{const required={...schema,required:['query']};assertCapabilitySchema(required);assert.throws(()=>validateCapabilityInput(required,{}),/INVALID_TOOL_INPUT/);assert.deepEqual(validateCapabilityInput(required,{query:'Get-Date'}),{query:'Get-Date'});});
test('Nonmatching default annotation cannot change enum or actual input validation',()=>{const s={type:'string',enum:['allowed'],default:'descriptive-only'};assertCapabilitySchema(s);assert.equal(validateCapabilityInput(s,'allowed'),'allowed');assert.throws(()=>validateCapabilityInput(s,'descriptive-only'),/INVALID_TOOL_INPUT/);});
test('Non-JSON and excessive annotations remain rejected',()=>{for(const value of [undefined,()=>1,NaN,1n,Array(257).fill(null)])assert.throws(()=>assertCapabilitySchema({type:'string',default:value}),/INVALID_CAPABILITY_SCHEMA/);});
test('Unsupported validation constraints remain unsupported',()=>{for(const extension of [{pattern:'x'},{oneOf:[{type:'string'}]},{$ref:'#/thing'}])assert.throws(()=>assertCapabilitySchema({type:'string',default:null,...extension}),/INVALID_CAPABILITY_SCHEMA/);});
test('Explicit grant preserves the discovered schema and does not enable tools implicitly',()=>{const d=describeCustomMcpTool({name:'docs_search',inputSchema:schema}),tool={name:d.name,description:d.description,inputSchema:d.inputSchema,schemaHash:d.schemaHash,effect:'read',enabled:true};const server=normalizeCustomMcpServer({id:'docs_qa',transport:'http',url:'https://example.com/mcp',enabled:true,tools:[tool]});assert.equal(server.tools[0].inputSchema.properties.query.default,null);assert.equal(server.tools[0].effect,'read');assert.equal(server.tools[0].enabled,true);});
const result={at:new Date().toISOString(),passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,scope:'Synthetic schemas with actual discovery, grant and input validators; no network, model or production.'};
if(process.env.BH_TEST_RESULT)await fs.writeFile(process.env.BH_TEST_RESULT,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
