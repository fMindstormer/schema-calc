// One fresh process per candidate avoids retaining many large generated Ajv
// programs in the same heap. No changes to validator internals or input data.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
const {schema,data}=JSON.parse(readFileSync(0,'utf8'));
const start=performance.now();
const validate=new Ajv2020({strict:true,inlineRefs:false}).compile(schema);
const prepareMs=performance.now()-start;
for(const [label,records] of Object.entries(data))for(const record of records)assert.equal(validate(record),label.startsWith('valid'));
for(const [label,records] of Object.entries(data))for(let i=0;i<10000;i++)validate(records[i%records.length]);
const samples=Object.fromEntries(Object.keys(data).map(label=>[label,[]]));
for(let round=0;round<9;round++)for(const [label,records]of Object.entries(data)){
 const start=performance.now();let accepted=0;
 for(let i=0;i<8192;i++)accepted+=validate(records[i%records.length])?1:0;
 assert.equal(accepted,label.startsWith('valid')?8192:0);
 samples[label].push((performance.now()-start)/8192);
}
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
process.stdout.write(JSON.stringify({prepareMs,ajv:Object.fromEntries(Object.entries(samples).map(([label,v])=>[label,{medianMs:median(v),samplesMs:v}]))}));
