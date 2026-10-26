// The compiler is deliberately absent: these are ordinary exported JSON files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';

const read = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const schema = await read('invoice.schema.json');
const validate = new Ajv2020().compile(schema);
for (const [file, expected] of [['invoice.valid.json', true], ['invoice.invalid.json', false]]) {
  const record = await read(file);
  const accepted = validate(record);
  assert.equal(accepted, expected, file);
  console.log(`${accepted ? 'ACCEPT' : 'REJECT'}  total=${record.total}  (${file})`);
}
