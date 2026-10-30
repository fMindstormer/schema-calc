// Runs one JavaScript validator over a corpus with its default options and prints
// the shared result format (see compat/README.md). Usage: node run.mjs <validator> <corpus.json> [first group]
import { readFileSync, writeSync } from 'node:fs';

// Written synchronously so the harness sees each group as soon as it finishes.
const emit = value => writeSync(1, `${JSON.stringify(value)}\n`);
const version = name => JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;

const validators = {
  async ajv() {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    return { package: 'ajv', prepare: schema => new Ajv2020().compile(schema) };
  },
  async hyperjump() {
    const { registerSchema, unregisterSchema, validate } = await import('@hyperjump/json-schema/draft-2020-12');
    let n = 0;
    return {
      package: '@hyperjump/json-schema',
      async prepare(schema) {
        const uri = schema.$id ?? `https://schema-calc.invalid/compat/${n++}`;
        if (schema.$id) unregisterSchema(uri), registerSchema(schema);
        else registerSchema(schema, uri);
        const check = await validate(uri);
        return data => check(data).valid;
      },
    };
  },
  async cfworker() {
    const { Validator } = await import('@cfworker/json-schema');
    return {
      package: '@cfworker/json-schema',
      prepare(schema) {
        const validator = new Validator(schema, '2020-12');
        return data => validator.validate(data).valid;
      },
    };
  },
  async schemasafe() {
    const { validator } = await import('@exodus/schemasafe');
    return { package: '@exodus/schemasafe', prepare: schema => validator(schema) };
  },
};

const [name, corpusPath, first = '0'] = process.argv.slice(2);
if (!validators[name] || !corpusPath) {
  console.error(`usage: node run.mjs <${Object.keys(validators).join('|')}> <corpus.json> [first group]`);
  process.exit(2);
}
const runner = await validators[name]();
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
emit({
  validator: runner.package, version: version(runner.package), language: 'JavaScript',
  runtime: `Node.js ${process.versions.node}`,
});
for (let index = Number(first); index < corpus.length; index++) {
  const group = corpus[index];
  const result = { index, name: group.name, cases: group.cases.length, falseAccepts: 0, falseRejects: 0, caseErrors: 0, caseError: null, error: null };
  const started = performance.now();
  try {
    const check = await runner.prepare(group.schema);
    result.loadSeconds = (performance.now() - started) / 1000;
    emit({ heartbeat: index, done: 0 });
    for (const [done, { data, expected }] of group.cases.entries()) {
      if (done && done % 100 === 0) emit({ heartbeat: index, done });
      let actual;
      try { actual = await check(data); }
      catch (error) { result.caseErrors++; result.caseError ??= String(error?.message ?? error).slice(0, 300); continue; }
      if (actual && !expected) result.falseAccepts++;
      if (!actual && expected) result.falseRejects++;
    }
  } catch (error) { result.error = String(error?.message ?? error).slice(0, 300); }
  emit({ ...result, seconds: (performance.now() - started) / 1000 });
}
