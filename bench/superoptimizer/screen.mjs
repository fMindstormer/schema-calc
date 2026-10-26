import {writeFile,mkdir} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {compile} from './compiler.mjs';
import {presets} from '../../src/presets.mjs';
import {compile as production} from '../../src/compiler.mjs';
import {compile as fast} from '../mixed-radix-compiler.mjs';
const cases=[];
for(const [name,preset] of Object.entries(presets)) {
 const configs=[['fast',null,fast],['production',null,production]];
 for(const packed of [false,true]) for(const mode of ['none','binary','pairs','both']) for(const weight of mode==='none'?[0]:mode==='binary'?[0,24,100,400,1600]:[0,24,400]) {
   const config={mode,weight,packed}; configs.push([`${packed?'packed':'flat'}-${mode}-${weight}`,config,s=>compile(s,config)]);
 }
 for(const packed of [false,true]) { const config={mode:'binary',weight:24,packed,macros:false}; configs.push([`${packed?'packed':'flat'}-binary-no-macros`,config,s=>compile(s,config)]); }
 const seen=new Map();
 for(const [implementation,config,build] of configs) {
  const start=performance.now(), result=build(preset.spec), compileMs=performance.now()-start;
  const json=JSON.stringify(result.schema);
  if(seen.has(json)) {console.log(`${name} ${implementation}: identical to ${seen.get(json)}`);continue;}
  seen.set(json,implementation);
  const prepareStart=performance.now();
  const validate=new Ajv2020({strict:true,inlineRefs:false}).compile(result.schema);
  const prepareMs=performance.now()-prepareStart;
  if(!validate(preset.valid) || validate(preset.invalid)) throw Error(`${name}/${implementation}`);
  function time(data) {
   for(let i=0;i<1000;i++) validate(data);
   const times=[];
   for(let b=0;b<5;b++){const t=performance.now();for(let i=0;i<10000;i++)validate(data);times.push((performance.now()-t)/10000);}
   return times.sort((a,b)=>a-b)[2];
  }
  const row={name,implementation,config,bytes:Buffer.byteLength(json),compileMs,prepareMs,validMs:time(preset.valid),invalidMs:time(preset.invalid),stats:result.stats};
  cases.push({...row,schema:result.schema,valid:preset.valid,invalid:preset.invalid});
  console.log(`${name} ${implementation}: ${row.bytes} B; ${(row.validMs*1000).toFixed(2)}/${(row.invalidMs*1000).toFixed(2)} us; prep ${prepareMs.toFixed(1)} ms`);
 }
}
await mkdir(new URL('../scratch/',import.meta.url),{recursive:true});
await writeFile(new URL('../scratch/superoptimizer-screen.json',import.meta.url),JSON.stringify(cases));
await writeFile(new URL('screen-results.json',import.meta.url),JSON.stringify(cases.map(({schema,valid,invalid,...row})=>row),null,2)+'\n');
