import {readFile,writeFile,mkdir} from 'node:fs/promises';
const path=new URL('results.json',import.meta.url);
const result=JSON.parse(await readFile(path,'utf8'));
if(result.rows.some(row=>!row.python))throw Error('Run the Python benchmark first.');
result.comparison=[];
for(const name of ['invoice','allocation','carry']) {
 const rows=result.rows.filter(row=>row.name===name);
 for(const baselineName of ['production','fast','flat-none-0','prior-pair']) {
  const baseline=rows.find(row=>row.implementation===baselineName);
  const comparisons=rows.filter(row=>row.config && row.config.mode!=='none').map(row=>{
   const ratios=Object.fromEntries(['ajv','python'].flatMap(engine=>['valid','invalid','malformed'].map(label=>
    [`${engine}/${label}`,row[engine][label].medianMs/baseline[engine][label].medianMs])));
   return {implementation:row.implementation,bytes:row.bytes,sizeRatio:row.bytes/baseline.bytes,ratios,
    allMediansNoHigher:row.bytes<baseline.bytes&&Object.values(ratios).every(r=>r<=1),
    withinFivePercent:row.bytes<baseline.bytes&&Object.values(ratios).every(r=>r<=1.05)};
  });
  const smallest=comparisons.reduce((a,b)=>a.bytes<=b.bytes?a:b);
  result.comparison.push({name,baseline:baselineName,smallest,
   allMediansNoHigher:comparisons.filter(r=>r.allMediansNoHigher).map(r=>r.implementation),
   withinFivePercent:comparisons.filter(r=>r.withinFivePercent).map(r=>r.implementation)});
 }
}
result.gate='Size must decrease and each warm workload median in each validator must not rise. A separate 5% band describes near-ties only; it is not proof of no slowdown. Compare valid, arithmetic-invalid, and malformed workloads separately. No automatic production promotion.';
await writeFile(path,JSON.stringify(result,null,2)+'\n');
for(const row of result.comparison) console.log(JSON.stringify(row));

const artifacts=new URL('artifacts/',import.meta.url);
await mkdir(artifacts,{recursive:true});
const cases=JSON.parse(await readFile(new URL('../scratch/superoptimizer-benchmark.json',import.meta.url),'utf8'));
const manifest=[];
for(const name of ['invoice','allocation','carry']) {
 const smallest=result.rows.filter(r=>r.name===name&&r.config&&r.config.mode!=='none').sort((a,b)=>a.bytes-b.bytes)[0];
 const item=cases.find(c=>c.name===name&&c.implementation===smallest.implementation);
 await writeFile(new URL(`${name}.candidate.schema.json`,artifacts),JSON.stringify(item.schema)+'\n');
 manifest.push({name,file:`${name}.candidate.schema.json`,implementation:smallest.implementation,config:smallest.config,bytes:smallest.bytes,
   purpose:'Smallest searched candidate, not an approved replacement. See performance comparisons.',comparisons:result.comparison.filter(r=>r.name===name)});
}
await writeFile(new URL('manifest.json',artifacts),JSON.stringify(manifest,null,2)+'\n');
