#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { compile } from '../src/compiler.mjs';
import { compileTally, encodeTally, decodeTally } from '../src/tally.mjs';

const args = process.argv.slice(2);
const mode = args[0]?.startsWith('--') && args[0] !== '--help' ? args.shift() : 'flat';
const [input, output, ...extra] = args;
if (mode === '--encode-tally' || mode === '--decode-tally') {
  try {
    if (!input || !output || extra.length > 1) throw new Error(`Usage: ${mode} contract.json record.json [output.json]`);
    const spec = JSON.parse(await readFile(input, 'utf8'));
    const record = JSON.parse(await readFile(output, 'utf8'));
    const value = mode === '--encode-tally' ? encodeTally(spec, record) : decodeTally(spec, record);
    const json = JSON.stringify(value) + '\n';
    if (extra[0]) await writeFile(extra[0], json); else process.stdout.write(json);
  } catch (error) { console.error(`schema-calc: ${error.message}`); process.exitCode = 1; }
} else {
if (!input || extra.length || input === '--help') {
  console.error('Usage: node bin/schema-calc.mjs [--tally] contract.json [output.schema.json]\n       node bin/schema-calc.mjs --encode-tally|--decode-tally contract.json record.json [output.json]');
  process.exitCode = input === '--help' ? 0 : 1;
} else {
  try {
    if (!['flat', '--tally'].includes(mode)) throw new Error(`Unknown option: ${mode}`);
    const { schema, stats } = (mode === '--tally' ? compileTally : compile)(JSON.parse(await readFile(input, 'utf8')));
    const json = JSON.stringify(schema) + '\n';
    if (output) await writeFile(output, json); else process.stdout.write(json);
    console.error(`${stats.bytes.toLocaleString()} bytes; ${stats.definitions} definitions; at most ${stats.maxCountTests ?? stats.maxDigitTests} ${mode === '--tally' ? 'count' : 'digit'} tests per record.`);
  } catch (error) {
    console.error(`schema-calc: ${error.message}`);
    process.exitCode = 1;
  }
}
}
