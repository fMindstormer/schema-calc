import { mkdir, writeFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile as mixedRadix } from './mixed-radix-compiler.mjs';
import { compile as packed } from '../src/compiler.mjs';
import { compile as pair } from './experimental/pair-compiler.mjs';
import { presets } from '../src/presets.mjs';

function measure(action) {
  for (let i = 0; i < 1000; i++) action();
  const times = [];
  for (let batch = 0; batch < 5; batch++) {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) action();
    times.push((performance.now() - start) / 10000);
  }
  return times.sort((a,b) => a-b)[2];
}
const rows = [], cases = [];
for (const [name, preset] of Object.entries(presets)) {
  for (const [implementation, compile] of [['mixed-radix', mixedRadix], ['packed', packed], ['pair-experiment', pair]]) {
    const start = performance.now();
    const { schema, stats, phases } = compile(preset.spec);
    const compileMs = performance.now() - start;
    if (implementation === 'pair-experiment') await writeFile(new URL(`experimental/${name}.pair.schema.json`, import.meta.url), JSON.stringify(schema) + '\n');
    const preparing = performance.now();
    const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
    const prepareMs = performance.now() - preparing;
    if (!validate(preset.valid) || validate(preset.invalid)) throw new Error(`${name}/${implementation}`);
    const row = { name, implementation, bytes: stats.bytes, payloadBytes: Buffer.byteLength(JSON.stringify(preset.valid)),
      phases, compileMs, prepareMs, validMs: measure(() => validate(preset.valid)), invalidMs: measure(() => validate(preset.invalid)) };
    rows.push(row); cases.push({ name, implementation, schema, valid: preset.valid, invalid: preset.invalid });
    console.log(`${name} ${implementation}: ${row.bytes} B, prepare ${prepareMs.toFixed(1)} ms, valid ${(row.validMs*1000).toFixed(2)} μs, invalid ${(row.invalidMs*1000).toFixed(2)} μs`);
  }
}
await mkdir(new URL('scratch/', import.meta.url), { recursive: true });
await writeFile(new URL('flat-results.json', import.meta.url), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  methodology: 'Identical original flat JSON, equations and precision for all variants; no input conversion or helper. Compact UTF-8 bytes. Stock Ajv strict:true, inlineRefs:false. Warm validation: median of 5 batches of 10000 after 1000 warmups. One compiler/preparation run. Experimental phase selection minimizes schema bytes, not validation time.', rows }, null, 2) + '\n');
await writeFile(new URL('scratch/flat-benchmark-cases.json', import.meta.url), JSON.stringify(cases));
