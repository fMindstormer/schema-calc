// Compare the compiled EN 16931 totals schema with the official Schematron on the
// official example invoices and on one-cent changes of them. Run en16931/fetch.sh
// first; needs Python 3 and a JDK (JAVA_HOME, or java on the PATH).
//   node en16931/run.mjs [--python] [--write]
// --python also validates the unchanged examples with Python jsonschema, which needs
// a raised recursion limit and takes seconds per invoice. --write records the results
// in en16931/results.json and the generated block of docs/en16931.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { arch, cpus, platform } from 'node:os';
import { compile } from '../src/compiler.mjs';
import { prepareValidator } from '../src/ajv-validator.mjs';

const root = new URL('..', import.meta.url).pathname;
const scratch = join(root, 'bench/scratch/en16931'), artefacts = join(scratch, 'artefacts');
const args = process.argv.slice(2);
const RULES = ['BR-CO-10', 'BR-CO-13', 'BR-CO-15', 'BR-CO-16'];
const REPEAT = 50;
const contract = JSON.parse(readFileSync(join(root, 'en16931/contract.json'), 'utf8'));
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/java') : 'java';
const classpath = ['Saxon-HE-12.5.jar', 'xmlresolver-5.2.2.jar', 'xmlresolver-5.2.2-data.jar'].map(jar => join(scratch, 'saxon', jar)).join(':');
const python = process.env.PYTHON ?? join(root, '.venv/bin/python');

function run(command, argv, input) {
  const result = spawnSync(command, argv, { input, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed:\n${result.stderr}`);
  return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];

// 1. Every official example, and copies with one or more totals raised by one cent.
const documents = [];
for (const syntax of ['ubl', 'cii']) {
  const dir = join(artefacts, syntax, 'examples'), out = join(scratch, 'changed', syntax);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stem = name.replace(/\.[^.]+$/, '');
    documents.push({ syntax, example: name, change: null, path });
    const [changed] = run('python3', ['-I', join(root, 'en16931/convert.py'), 'mutate', path, out]);
    for (const file of changed) documents.push({ syntax, example: name, change: basename(file).slice(stem.length + 1, -4), path: file });
  }
}

// 2. The official Schematron, compiled to XSLT, for each syntax.
const schematron = {};
for (const syntax of ['ubl', 'cii']) {
  const xslt = join(artefacts, syntax, 'xslt', `EN16931-${syntax.toUpperCase()}-validation.xslt`);
  const docs = documents.filter(d => d.syntax === syntax);
  const [{ compileMs }, ...reports] = run(java, ['-cp', classpath, join(root, 'en16931/Schematron.java'), xslt, String(REPEAT)], docs.map(d => d.path).join('\n'));
  schematron[syntax] = { compileMs };
  reports.forEach((report, i) => Object.assign(docs[i], { schematronFailed: RULES.filter(rule => report.failed.includes(rule)), otherFailed: report.failed.filter(id => !RULES.includes(id)), schematronMs: report.medianMs }));
}

// 3. The JSON form of each invoice.
run('python3', ['-I', join(root, 'en16931/convert.py'), 'lines'], documents.map(d => d.path).join('\n')).forEach((record, i) => { documents[i].record = record; });
const AMOUNT = new RegExp(`^-?(0|[1-9][0-9]{0,${contract.integerDigits - 1}})\\.[0-9]{2}$`);
const representable = ({ lines, ...totals }) => lines.length <= contract.lists.lines.maxItems &&
  [...Object.values(totals), ...lines.map(line => line.netAmount)].every(value => typeof value === 'string' && AMOUNT.test(value));

// 4. One schema for all four rules, and one for each rule alone.
function prepare(constraints) {
  let start = performance.now();
  const { schema, stats } = compile({ ...contract, constraints }, { maxDefinitions: 3e6 });
  const compileMs = performance.now() - start;
  start = performance.now();
  const validate = prepareValidator(schema);
  return { schema, bytes: stats.bytes, compileMs, prepareMs: performance.now() - start, validate };
}
const combined = prepare(contract.constraints);
writeFileSync(join(scratch, 'en16931.schema.json'), JSON.stringify(combined.schema));
const single = contract.constraints.map(constraint => prepare([constraint]));

// 5. Validate, time, and compare each rule's verdict with the Schematron's.
for (const doc of documents) {
  doc.representable = representable(doc.record);
  doc.jsonFailed = RULES.filter((_, i) => !single[i].validate(doc.record));
  doc.combinedValid = combined.validate(doc.record);
  for (let i = 0; i < REPEAT; i++) combined.validate(doc.record);
  doc.ajvMs = median(Array.from({ length: REPEAT }, () => { const start = performance.now(); combined.validate(doc.record); return performance.now() - start; }));
  doc.agrees = doc.jsonFailed.join() === doc.schematronFailed.join() && doc.combinedValid === !doc.schematronFailed.length;
}

// 6. Optionally, Python jsonschema on the unchanged examples.
let pythonResults = null;
if (args.includes('--python')) {
  const originals = documents.filter(d => !d.change);
  const [info, ...verdicts] = run(python, ['-I', join(root, 'en16931/python_check.py'), join(scratch, 'en16931.schema.json')], originals.map(d => JSON.stringify(d.record)).join('\n'));
  verdicts.forEach((verdict, i) => Object.assign(originals[i], { pythonValid: verdict.valid, pythonMs: verdict.ms }));
  pythonResults = { ...info, agree: originals.every(d => d.pythonValid === d.combinedValid), medianMs: median(originals.map(d => d.pythonMs)) };
}

const inForm = documents.filter(d => d.representable);
const summary = {
  artefacts: 'validation-1.3.17', saxon: 'Saxon-HE 12.5', ajv: JSON.parse(readFileSync(join(root, 'node_modules/ajv/package.json'), 'utf8')).version,
  environment: { node: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model, java: spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0] },
  documents: documents.length, examples: documents.filter(d => !d.change).length, outsideForm: documents.filter(d => !d.representable).map(d => `${d.example}${d.change ? ` +${d.change}` : ''}`),
  agree: inForm.filter(d => d.agrees).length, compared: inForm.length,
  byRule: Object.fromEntries(RULES.map((rule, i) => [rule, {
    schematronFails: inForm.filter(d => d.schematronFailed.includes(rule)).length,
    agree: inForm.filter(d => d.schematronFailed.includes(rule) === d.jsonFailed.includes(rule)).length,
    bytes: single[i].bytes
  }])),
  schema: { bytes: combined.bytes, compileMs: Math.round(combined.compileMs), prepareMs: Math.round(combined.prepareMs), validateMedianMs: median(inForm.map(d => d.ajvMs)) },
  schematron: { ublCompileMs: schematron.ubl.compileMs, ciiCompileMs: schematron.cii.compileMs, validateMedianMs: median(documents.map(d => d.schematronMs)) },
  python: pythonResults,
  disagreements: inForm.filter(d => !d.agrees).map(({ syntax, example, change, schematronFailed, jsonFailed, combinedValid }) => ({ syntax, example, change, schematronFailed, jsonFailed, combinedValid }))
};
console.log(JSON.stringify(summary, null, 2));

if (args.includes('--write')) {
  const rows = documents.map(({ syntax, example, change, representable, schematronFailed, otherFailed, jsonFailed, combinedValid, agrees, schematronMs, ajvMs, pythonValid, pythonMs }) =>
    ({ syntax, example, change, representable, schematronFailed, otherFailed, jsonFailed, combinedValid, agrees, schematronMs, ajvMs, pythonValid, pythonMs }));
  writeFileSync(join(root, 'en16931/results.json'), JSON.stringify({ summary, documents: rows }, null, 2) + '\n');
  const page = join(root, 'docs/en16931.md'), text = readFileSync(page, 'utf8');
  const kB = bytes => `${(bytes / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} kB`;
  const ms = value => value < 10 ? value.toFixed(2) : value.toFixed(0);
  const bySyntax = syntax => {
    const docs = inForm.filter(d => d.syntax === syntax);
    return `| ${syntax.toUpperCase()} | ${docs.filter(d => !d.change).length} | ${docs.filter(d => d.change).length} | ${docs.filter(d => d.schematronFailed.length).length} | ${docs.filter(d => d.agrees).length} of ${docs.length} |`;
  };
  const block = [
    '| Syntax | Examples | One-cent changes | Rejected by the Schematron | Same verdict, rule by rule |',
    '|---|---:|---:|---:|---:|',
    bySyntax('ubl'), bySyntax('cii'),
    '',
    '| Rule | Rejected by the Schematron | Same verdict | Schema for this rule alone |',
    '|---|---:|---:|---:|',
    ...RULES.map(rule => `| ${rule} | ${summary.byRule[rule].schematronFails} | ${summary.byRule[rule].agree} of ${inForm.length} | ${kB(summary.byRule[rule].bytes)} |`),
    `| All four | ${inForm.filter(d => d.schematronFailed.length).length} | ${inForm.filter(d => d.combinedValid === !d.schematronFailed.length).length} of ${inForm.length} | ${kB(combined.bytes)} |`,
    '',
    '| | Official Schematron (XSLT) | Compiled JSON Schema |',
    '|---|---:|---:|',
    `| Rules checked | All of EN 16931 | BR-CO-10, -13, -15, -16 |`,
    `| Size | ${kB(readFileSync(join(artefacts, 'ubl/xslt/EN16931-UBL-validation.xslt')).length)} (UBL), ${kB(readFileSync(join(artefacts, 'cii/xslt/EN16931-CII-validation.xslt')).length)} (CII) | ${kB(combined.bytes)} |`,
    `| Preparation | ${ms(schematron.ubl.compileMs)} ms (UBL), ${ms(schematron.cii.compileMs)} ms (CII), Saxon-HE 12.5 | ${(combined.prepareMs / 1000).toFixed(0)} s, Ajv ${summary.ajv} |`,
    `| Median validation | ${ms(summary.schematron.validateMedianMs)} ms | ${ms(summary.schema.validateMedianMs)} ms${pythonResults ? `; ${(pythonResults.medianMs / 1000).toFixed(1)} s in Python jsonschema` : ''} |`,
    '',
    `Measured on ${summary.environment.cpu}, ${summary.environment.platform}, Node ${process.version}, ${summary.environment.java}; medians of ${REPEAT} warm runs per invoice, excluding parsing.`
  ].join('\n');
  writeFileSync(page, text.replace(/<!-- results:start -->[\s\S]*<!-- results:end -->/, `<!-- results:start -->\n${block}\n<!-- results:end -->`));
}
process.exit(summary.agree === summary.compared && !summary.outsideForm.length ? 0 : 1);
