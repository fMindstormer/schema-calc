// Compile a schema with Ajv's own compile, in a fresh process, with default options
// or with only inlineRefs: false, then validate JSON records, one per line on stdin.
// Prints a JSON line with the compile time, then one verdict per record; a verdict
// is null if validating that record overflowed the stack.
//   node en16931/plain_ajv.mjs SCHEMA.json [--no-inline] < records
import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const options = process.argv.includes('--no-inline') ? { inlineRefs: false } : {};
const start = performance.now();
let validate;
try {
  validate = new Ajv2020({ logger: false, ...options }).compile(schema);
} catch (error) {
  console.log(JSON.stringify({ compiled: false, ms: Math.round(performance.now() - start), error: String(error.message).slice(0, 80) }));
  process.exit(0);
}
console.log(JSON.stringify({ compiled: true, ms: Math.round(performance.now() - start) }));
for (const line of readFileSync(0, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let valid = null;
  try { valid = validate(JSON.parse(line)); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  console.log(JSON.stringify({ valid }));
}
