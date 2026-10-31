import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile as baseline } from './baseline-compiler.mjs';
import { compile as mixedRadix } from './mixed-radix-compiler.mjs';
import { compile as optimized } from '../src/compiler.mjs';
import { prepareValidator } from '../src/ajv-validator.mjs';
import { benchmarked as presets } from '../src/presets.mjs';

const rows = [];
for (const [name, preset] of Object.entries(presets)) {
  for (const [implementation, compile] of [['original', baseline], ['mixed-radix', mixedRadix], ['packed', optimized]]) {
    const start = performance.now();
    const { schema, stats } = compile(preset.spec);
    const compileMs = performance.now() - start;
    const preparing = performance.now();
    const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
    const prepareMs = performance.now() - preparing;
    if (!validate(preset.valid) || validate(preset.invalid)) throw new Error(`Incorrect ${name} / ${implementation}`);
    function measure(data) {
      for (let i = 0; i < 100; i++) validate(data);
      const runs = [];
      for (let batch = 0; batch < 5; batch++) {
        const start = performance.now();
        for (let i = 0; i < 1000; i++) validate(data);
        runs.push((performance.now() - start) / 1000);
      }
      return runs.sort((a,b) => a-b)[2];
    }
    const row = { name, implementation, bytes: stats.bytes, gzipBytes: gzipSync(JSON.stringify(schema)).length,
      definitions: stats.definitions, decisionNodes: stats.decisionNodes, compileMs, prepareMs,
      validMs: measure(preset.valid), invalidMs: measure(preset.invalid) };
    if (implementation === 'packed') {
      const start = performance.now();
      const prepared = prepareValidator(schema);
      row.browserPrepareMs = performance.now() - start;
      if (!prepared(preset.valid) || prepared(preset.invalid)) throw new Error('Preparation changed validation');
    }
    rows.push(row);
    console.log(`${name.padEnd(11)} ${implementation.padEnd(10)} ${row.bytes.toString().padStart(7)} B  prepare ${prepareMs.toFixed(1)} ms  valid ${(row.validMs*1000).toFixed(1)} μs`);
  }
}
const result = { node: process.version, platform: process.platform, arch: process.arch,
  methodology: 'Compact UTF-8 JSON; identical contracts and domains. All three use stock Ajv strict:true, inlineRefs:false. Validation: median of 5 batches of 1000 after 100 warmups. Compiler/preparation: one run, indicative. browserPrepareMs separately times standards-based unbundling and dependency-ordered preparation; it is not the stock preparation column.', rows };
await writeFile(new URL('results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
