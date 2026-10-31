// One predeclared follow-up on new input seeds for candidates near the joint gate.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workload} from './workload.mjs';
import {benchmarked as presets} from '../../src/presets.mjs';
const all=JSON.parse(await readFile(new URL('../scratch/superoptimizer-benchmark.json',import.meta.url),'utf8'));
const targets={invoice:['production','packed-binary-1600'],allocation:['production','prior-pair','packed-binary-1600'],
 carry:['production','prior-pair','packed-binary-24','packed-both-24','packed-both-400']};
const cases=[],rows=[];
for(const [index,seed]of [0xc001d00d,0x51a7e5ed].entries()) {
 const selected=all.filter(row=>targets[row.name].includes(row.implementation));
 if(index)selected.reverse();
 for(const item of selected) {
  const data={...workload(item.name,seed),validExample:[presets[item.name].valid],invalidExample:[presets[item.name].invalid]};
  const measured=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('worker.mjs',import.meta.url))],
   {input:JSON.stringify({schema:item.schema,data}),encoding:'utf8',timeout:90000,maxBuffer:1024*1024}));
  rows.push({name:item.name,implementation:item.implementation,seed,...measured});
  cases.push({name:item.name,implementation:item.implementation,seed,schema:item.schema,data});
  console.log(item.name,item.implementation,seed,...Object.values(measured.ajv).map(x=>(x.medianMs*1000).toFixed(2)+' us'));
 }
}
await writeFile(new URL('confirmation.json',import.meta.url),JSON.stringify({methodology:'Predeclared promising candidates; two new deterministic workloads, same broad class counts and Node timing method, plus the original accepted/rejected example records as separate classes. Reverse candidate order on second seed. No tuning after confirmation.',rows},null,2)+'\n');
await writeFile(new URL('../scratch/superoptimizer-confirmation.json',import.meta.url),JSON.stringify(cases));
