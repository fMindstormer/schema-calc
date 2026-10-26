import { mkdir, writeFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile as mixedRadix } from './mixed-radix-compiler.mjs';
import { compile as packed } from '../src/compiler.mjs';
import { compileTally, encodeTally } from '../src/tally.mjs';
import { presets } from '../src/presets.mjs';

function measure(action) {
  for (let i = 0; i < 1000; i++) action();
  const times = [];
  for (let batch = 0; batch < 5; batch++) {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) action();
    times.push((performance.now() - start) / 10000);
  }
  return times.sort((a, b) => a - b)[2];
}
const rows = [], cases = [];
for (const [name, preset] of Object.entries(presets)) {
  for (const [implementation, compile] of [['mixed-radix', mixedRadix], ['packed', packed], ['tally', compileTally]]) {
    const output = compile(preset.spec);
    const valid = implementation === 'tally' ? encodeTally(preset.spec, preset.valid) : preset.valid;
    const invalid = implementation === 'tally' ? encodeTally(preset.spec, preset.invalid) : preset.invalid;
    const start = performance.now();
    const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(output.schema);
    const prepareMs = performance.now() - start;
    if (!validate(valid) || validate(invalid)) throw new Error(`${name}/${implementation}`);
    const row = { name, implementation, bytes: output.stats.bytes, payloadBytes: Buffer.byteLength(JSON.stringify(valid)),
      prepareMs, validMs: measure(() => validate(valid)), invalidMs: measure(() => validate(invalid)) };
    if (implementation === 'tally') row.encodeMs = measure(() => encodeTally(preset.spec, preset.valid));
    rows.push(row); cases.push({ name, implementation, schema: output.schema, valid, invalid });
    console.log(`${name} ${implementation}: ${row.bytes} B, input ${row.payloadBytes} B, prepare ${prepareMs.toFixed(1)} ms, valid ${(row.validMs * 1000).toFixed(2)} μs${row.encodeMs ? `, encode ${(row.encodeMs * 1000).toFixed(2)} μs` : ''}`);
  }
}
await writeFile(new URL('tally-results.json', import.meta.url), JSON.stringify({ node: process.version, platform: process.platform,
  methodology: 'Compact UTF-8 bytes. Tally uses a different, lossless input representation; the numeric domain and equations are unchanged. Stock Ajv strict:true, inlineRefs:false. Median of 5 batches of 10000 after 1000 warmups; one preparation run. encodeMs is the complete public encoder, including contract parsing and format checks, timed separately. Python adds its own validator-only timings below.', rows }, null, 2) + '\n');
await mkdir(new URL('scratch/', import.meta.url), { recursive: true });
await writeFile(new URL('scratch/tally-benchmark-cases.json', import.meta.url), JSON.stringify(cases));
