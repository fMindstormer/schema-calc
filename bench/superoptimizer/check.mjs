import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {compile} from './compiler.mjs';
import {searchCache,searchStats,points,evaluateProgram} from './search.mjs';

const source=JSON.parse(await readFile(new URL('../../test/corpus.json',import.meta.url),'utf8'));
// Stress limits not exercised by the earlier flat corpus.
source.push({name:'twelve-digit arithmetic',spec:{fields:['a','b','total'],constraints:['a+b=total'],integerDigits:10,scale:2},cases:[
  {data:{a:'9999999999.98',b:'0.01',total:'9999999999.99'},expected:true},
  {data:{a:'9999999999.99',b:'0.01',total:'0.00'},expected:false},
  {data:{a:'0.00',b:'0.00',total:'0.00'},expected:true}]});
source.push({name:'sixteen terms',spec:{fields:['a','total'],constraints:[`${Array(15).fill('a').join('+')}=total`],integerDigits:2,scale:0},cases:[
  {data:{a:'6',total:'90'},expected:true},{data:{a:'7',total:'5'},expected:false},{data:{a:'0',total:'0'},expected:true}]});
source.push({name:'eight fields',spec:{fields:['a','b','c','d','e','f','g','total'],constraints:['a+b+c+d+e+f+g=total'],integerDigits:1,scale:0},cases:[
  {data:{a:'1',b:'1',c:'1',d:'1',e:'1',f:'1',g:'1',total:'7'},expected:true},
  {data:{a:'9',b:'9',c:'9',d:'9',e:'9',f:'9',g:'9',total:'3'},expected:false},
  {data:{a:'0',b:'0',c:'0',d:'0',e:'0',f:'0',g:'0',total:'0'},expected:true}]});
const corpus=[];let count=0;
const profiles=[['size-packed',{packed:true,weight:0,mode:'binary'}],
 ['balanced-packed',{packed:true,weight:24,mode:'binary'}],
 ['work-packed',{packed:true,weight:1600,mode:'binary'}],
 ['pair-flat',{packed:false,weight:24,mode:'both'}],
 ['balanced-both-packed',{packed:true,weight:24,mode:'both'}],
 ['work-both-packed',{packed:true,weight:400,mode:'both'}]];
const keywords=new Set(['$schema','$id','$defs','$ref','$comment','title','type','required','additionalProperties','properties','pattern','allOf','oneOf','not','if','then','else']);
function audit(node,ids,refs,base='https://local.invalid/') {
  if(typeof node==='boolean')return;
  if(node.$id){base=new URL(node.$id,base).href;ids.add(base);}
  for(const [key,value] of Object.entries(node)) {
    assert.ok(keywords.has(key),`Nonstandard/generated unexpected keyword ${key}`);
    if(key==='$ref')refs.push({value,base});
    else if(key==='$defs'||key==='properties')Object.values(value).forEach(child=>audit(child,ids,refs,base));
    else if(key==='allOf'||key==='oneOf')value.forEach(child=>audit(child,ids,refs,base));
    else if(['not','if','then','else'].includes(key))audit(value,ids,refs,base);
  }
}
for(const group of source)for(const [profile,options]of profiles) {
  assert.ok(group.spec,'Run npm test first.');
  const {schema,stats}=compile(group.spec,options);
  const ids=new Set(),refs=[];audit(schema,ids,refs);
  for(const {value,base}of refs) {
    if(value.startsWith('#/$defs/'))assert.ok(Object.hasOwn(schema.$defs,value.slice(8)));
    else assert.ok(ids.has(new URL(value,base).href),`External reference: ${value}`);
  }
  const validate=new Ajv2020({strict:true,inlineRefs:false}).compile(schema);
  for(const {data,expected}of group.cases){assert.equal(validate(data),expected,`${profile}/${group.name}: ${JSON.stringify(data)}`);count++;}
  corpus.push({...group,name:`${profile}/${group.name}`,schema,stats});
  console.log(`${profile}/${group.name}: ${group.cases.length} passed`);
}
const certificates=[...searchCache].filter(([,result])=>result).map(([key,result])=>{
  const [radix,arity,labels,weight,macros,maxStates]=JSON.parse(key);
  points(radix,arity).forEach((row,i)=>assert.equal(evaluateProgram(result.node,row),labels[i]));
  return {radix,arity,labels,weight,macros,maxStates,program:result.node,cost:{bytes:result.bytes,work:result.work,expected:result.expected},search:result.search};
});
// Validate synthesized Boolean tests using the actual standard keywords, with
// every local arithmetic row and one-hot/all-false/all-true continuations. These
// small fixtures use ordinary flat decimal strings too, never a tally payload.
const micro=[];let microCount=0;
for(const [index,c]of certificates.entries()) {
  const symbols=[...new Set(c.labels.filter(x=>typeof x!=='boolean'))];
  const assignments=[[],symbols,...symbols.map(s=>[s])];
  const fields=Array.from({length:c.arity},(_,i)=>`x${i}`);
  function emitTest(t) {
    if(t.kind==='one')return {oneOf:t.args.map(emitTest)};
    const digits=Array.from({length:c.radix},(_,i)=>i).filter(i=>t.set&(1<<i));
    return {type:'object',properties:{[fields[t.field]]:{type:'string',enum:digits.map(String)}}};
  }
  for(const [j,truth]of assignments.entries()) {
    function emitNode(n) {
      if(n.kind==='leaf')return typeof n.value==='boolean'?n.value:truth.includes(n.value);
      return {if:emitTest(n.test),then:emitNode(n.yes),else:emitNode(n.no)};
    }
    const schema={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',required:fields,additionalProperties:false,
      properties:Object.fromEntries(fields.map(f=>[f,{type:'string',enum:Array.from({length:c.radix},(_,i)=>String(i))}])),allOf:[emitNode(c.program)]};
    const cases=points(c.radix,c.arity).map((row,i)=>({data:Object.fromEntries(fields.map((f,k)=>[f,String(row[k])])),
      expected:typeof c.labels[i]==='boolean'?c.labels[i]:truth.includes(c.labels[i])}));
    const validate=new Ajv2020({strict:true,inlineRefs:false}).compile(schema);
    for(const {data,expected}of cases){assert.equal(validate(data),expected);microCount++;}
    micro.push({name:`cell ${index} continuation ${j}`,schema,cases});
  }
}
await writeFile(new URL('../../test/superoptimizer-cells.json',import.meta.url),JSON.stringify(micro));
await writeFile(new URL('../../test/superoptimizer-corpus.json',import.meta.url),JSON.stringify(corpus));
await writeFile(new URL('programs.json',import.meta.url),JSON.stringify(certificates,null,2)+'\n');
await writeFile(new URL('verification.json',import.meta.url),JSON.stringify({ajvCases:count,schemas:corpus.length,sourceContracts:source.length,search:searchStats,certificates:certificates.length,microCases:microCount,microSchemas:micro.length},null,2)+'\n');
console.log(`PASS: ${count} flat records across ${corpus.length} schemas. ${certificates.length} exhaustive local certificates.`);
