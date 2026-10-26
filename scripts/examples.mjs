import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compile } from '../src/compiler.mjs';
import { presets } from '../src/presets.mjs';
import { compileTally, encodeTally } from '../src/tally.mjs';
const check = process.argv[2] === '--check';
if (process.argv.length > 3 || (process.argv[2] && !check)) throw new Error('Usage: node scripts/examples.mjs [--check]');
if (!check) await mkdir(new URL('../examples/', import.meta.url), { recursive: true });
async function emit(name, value, pretty = false) {
  const path = new URL(`../examples/${name}`, import.meta.url);
  const text = JSON.stringify(value, null, pretty ? 2 : 0) + '\n';
  if (check) {
    if (await readFile(path, 'utf8') !== text) throw new Error(`Stale example ${name}; run npm run examples.`);
  } else await writeFile(path, text);
}
for (const [name, preset] of Object.entries(presets)) {
  const { schema, stats } = compile(preset.spec);
  for (const [suffix, value] of Object.entries({ 'contract.json': preset.spec, 'schema.json': schema, 'valid.json': preset.valid, 'invalid.json': preset.invalid })) {
    await emit(`${name}.${suffix}`, value, suffix !== 'schema.json');
  }
  console.log(`${name}: ${stats.bytes} bytes, ${stats.decisionNodes} decision nodes, <=${stats.maxDigitTests} digit tests`);
  const tally = compileTally(preset.spec);
  for (const [suffix, value] of Object.entries({ 'schema': tally.schema, 'valid': encodeTally(preset.spec, preset.valid), 'invalid': encodeTally(preset.spec, preset.invalid) })) {
    await emit(`${name}.tally.${suffix}.json`, value);
  }
  console.log(`${name} tally: ${tally.stats.bytes} bytes, ${tally.stats.arithmeticStates} carry states`);
}
