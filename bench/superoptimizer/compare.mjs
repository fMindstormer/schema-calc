import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {workload} from './workload.mjs';
import {compile as priorPair} from '../experimental/pair-compiler.mjs';
import {benchmarked as presets} from '../../src/presets.mjs';
const screen=JSON.parse(await readFile(new URL('../scratch/superoptimizer-screen.json',import.meta.url),'utf8'));
for(const [name,preset]of Object.entries(presets)){
 const start=performance.now();const {schema,stats}=priorPair(preset.spec);
 screen.push({name,implementation:'prior-pair',schema,bytes:stats.bytes,compileMs:performance.now()-start});
}
const rows=[],cases=[];
for(const row of screen) {
 const {name,implementation,schema}=row;
 // Candidates larger than the corresponding established layout cannot pass the
 // joint gate, so do not spend time timing them. Keep the layout-only control.
 if(row.config && row.config.mode!=='none') {
  const baseline=screen.find(r=>r.name===name&&r.implementation===(row.config.packed?'production':'fast'));
  if(row.bytes>=baseline.bytes)continue;
 }
 const data=workload(name);
 const measured=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('worker.mjs',import.meta.url))],
  {input:JSON.stringify({schema,data}),encoding:'utf8',timeout:90000,maxBuffer:1024*1024}));
 const {schema:_,valid,invalid,...metadata}=row;
 rows.push({...metadata,...measured});cases.push({schema,data,name,implementation});
 console.log(name,implementation,row.bytes,...Object.values(measured.ajv).map(x=>(x.medianMs*1000).toFixed(2)+' us'));
}
const result={node:process.version,platform:process.platform,arch:process.arch,ajvVersion:'8.20.0',
 methodology:'Unmodified strict Ajv2020, inlineRefs:false; one fresh child process per candidate. Original flat JSON, same precision. Independent held-out workload per preset: 32 accepted, 32 arithmetic errors across digit positions, 8 malformed records. 10000 warmups per class; 9 batches of 8192 per class. Median milliseconds/record; compilation and preparation outside warm timing. One preparation sample. No browser helper, custom keywords, input conversion, or remote schemas. Candidates with no size reduction against their established layout baseline are screened out before this timing pass; layout-only controls retained.',rows};
await writeFile(new URL('results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
await writeFile(new URL('../scratch/superoptimizer-benchmark.json',import.meta.url),JSON.stringify(cases));
