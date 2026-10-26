import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile } from './experimental/pair-compiler.mjs';

const corpus = JSON.parse(await readFile(new URL('../test/corpus.json', import.meta.url), 'utf8'));
let count = 0;
for (const group of corpus) {
  assert.ok(group.spec, 'Run npm test to regenerate source specifications in the corpus.');
  const { schema, phases } = compile(group.spec);
  group.schema = schema;
  group.phases = phases;
  const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
  for (const { data, expected } of group.cases) {
    assert.equal(validate(data), expected, `${group.name}: ${JSON.stringify(data)}`);
    count++;
  }
  console.log(`${group.name}: ${group.cases.length} passed`);
}
await writeFile(new URL('../test/flat-experiment-corpus.json', import.meta.url), JSON.stringify(corpus));
console.log(`PASS: ${count} unchanged flat records across ${corpus.length} schemas.`);
