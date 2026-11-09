// Compare the compiled EN 16931 totals schemas, one for each syntax's Schematron, with
// the official Schematron on the official example invoices and on changed copies
// of them: amounts raised by one cent, or optional elements removed. Run en16931/fetch.sh
// first; needs Python 3 and a JDK (JAVA_HOME, or java on the PATH).
//   node en16931/run.mjs [--python] [--plain-ajv] [--write]
// --python also validates every invoice with Python jsonschema. --plain-ajv times
// Ajv's own compile of each whole schema, which takes minutes. --write records the
// results in en16931/results.json and the generated block of docs/en16931.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { arch, cpus, loadavg, platform } from 'node:os';
import { compile } from '../src/compiler.mjs';
import { prepareValidator } from '../src/ajv-validator.mjs';

const root = new URL('..', import.meta.url).pathname;
const scratch = join(root, 'bench/scratch/en16931'), artefacts = join(scratch, 'artefacts');
const args = process.argv.slice(2);
// Other work on the machine slows every timing below; the page says how busy it was.
const loadAtStart = loadavg()[0];
// In the order of each contract's constraints.
const RULES = ['BR-CO-10', 'BR-CO-11', 'BR-CO-12', 'BR-CO-13', 'BR-CO-14', 'BR-CO-15', 'BR-CO-16'];
const REPEAT = 50;
const SYNTAXES = ['ubl', 'cii'];
// One contract for each syntax, since the two Schematrons bind some rules differently.
const contracts = Object.fromEntries(SYNTAXES.map(syntax => [syntax, JSON.parse(readFileSync(join(root, `en16931/${syntax}.json`), 'utf8'))]));
const form = ({ title, constraints, ...rest }) => JSON.stringify(rest);
if (form(contracts.ubl) !== form(contracts.cii)) throw new Error('ubl.json and cii.json must declare the same JSON form.');
const contract = contracts.ubl;
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
for (const syntax of SYNTAXES) {
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
for (const syntax of SYNTAXES) {
  const xslt = join(artefacts, syntax, 'xslt', `EN16931-${syntax.toUpperCase()}-validation.xslt`);
  const docs = documents.filter(d => d.syntax === syntax);
  const [{ compileMs }, ...reports] = run(java, ['-cp', classpath, join(root, 'en16931/Schematron.java'), xslt, String(REPEAT)], docs.map(d => d.path).join('\n'));
  schematron[syntax] = { compileMs };
  reports.forEach((report, i) => Object.assign(docs[i], { schematronFailed: RULES.filter(rule => report.failed.includes(rule)), otherFailed: report.failed.filter(id => !RULES.includes(id)), schematronMs: report.medianMs }));
}

// 3. The JSON form of each invoice.
run('python3', ['-I', join(root, 'en16931/convert.py'), 'lines'], documents.map(d => d.path).join('\n')).forEach((record, i) => { documents[i].record = record; });
const AMOUNT = new RegExp(`^-?(0|[1-9][0-9]{0,${contract.integerDigits - 1}})\\.[0-9]{2}$`);
const listed = Object.entries(contract.lists);
const representable = record => contract.fields.every(field => contract.optional.includes(field) || record[field] !== undefined) && listed.every(([name, { maxItems }]) => Array.isArray(record[name]) && record[name].length <= maxItems) &&
  [...contract.fields.map(field => record[field]).filter(value => value !== undefined),
    ...listed.flatMap(([name, { fields: [field] }]) => record[name].map(item => item[field]))].every(value => typeof value === 'string' && AMOUNT.test(value));

// 4. For each syntax, one schema for all the rules, and one for each rule alone. A rule
// both syntaxes bind alike has one schema.
function prepare(spec) {
  let start = performance.now();
  const { schema, stats } = compile(spec, { maxDefinitions: 3e6 });
  const compileMs = performance.now() - start;
  start = performance.now();
  const validate = prepareValidator(schema);
  return { schema, bytes: stats.bytes, compileMs, prepareMs: performance.now() - start, validate };
}
const combined = {}, single = {}, singles = new Map();
for (const syntax of SYNTAXES) {
  combined[syntax] = prepare(contracts[syntax]);
  writeFileSync(join(scratch, `${syntax}.schema.json`), JSON.stringify(combined[syntax].schema));
  single[syntax] = contracts[syntax].constraints.map((constraint, i) => {
    if (!singles.has(constraint)) singles.set(constraint, prepare({ ...contract, title: `EN 16931 ${RULES[i]}`, constraints: [constraint] }));
    return singles.get(constraint);
  });
}

// 5. Validate, time, and compare each rule's verdict with the Schematron's.
for (const doc of documents) {
  doc.representable = representable(doc.record);
  const { validate } = combined[doc.syntax];
  doc.jsonFailed = RULES.filter((_, i) => !single[doc.syntax][i].validate(doc.record));
  doc.combinedValid = validate(doc.record);
  for (let i = 0; i < REPEAT; i++) validate(doc.record);
  doc.ajvMs = median(Array.from({ length: REPEAT }, () => { const start = performance.now(); validate(doc.record); return performance.now() - start; }));
  doc.agrees = doc.jsonFailed.join() === doc.schematronFailed.join() && doc.combinedValid === !doc.schematronFailed.length;
}

// 6. Optionally, Python jsonschema with its default options, and Ajv's own compile.
let pythonResults = null, plainAjv = null;
if (args.includes('--python')) {
  for (const syntax of SYNTAXES) {
    const docs = documents.filter(d => d.syntax === syntax);
    const [info, ...verdicts] = run(python, ['-I', join(root, 'en16931/python_check.py'), join(scratch, `${syntax}.schema.json`)], docs.map(d => JSON.stringify(d.record)).join('\n'));
    verdicts.forEach((verdict, i) => Object.assign(docs[i], { pythonValid: verdict.valid, pythonMs: verdict.ms }));
    pythonResults = info;
  }
  pythonResults = { ...pythonResults, agree: documents.filter(d => d.pythonValid === d.combinedValid).length, of: documents.length, medianMs: median(documents.map(d => d.pythonMs)) };
}
if (args.includes('--plain-ajv')) {
  // Fresh processes, since the stack these need depends on what ran before them.
  plainAjv = ['default', 'no-inline'].flatMap(options => SYNTAXES.map(syntax => {
    const docs = documents.filter(d => d.syntax === syntax), input = docs.map(d => JSON.stringify(d.record)).join('\n');
    const result = spawnSync(process.execPath, [join(root, 'en16931/plain_ajv.mjs'), join(scratch, `${syntax}.schema.json`), ...(options === 'no-inline' ? ['--no-inline'] : [])], { input, encoding: 'utf8', maxBuffer: 1 << 28 });
    const [info = { compiled: false }, ...verdicts] = result.stdout.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    return { options, syntax, ...info, crashed: result.status !== 0, overflowed: verdicts.filter(v => v.valid === null).length,
      agree: verdicts.filter((v, i) => v.valid === docs[i].combinedValid).length, of: docs.length };
  }));
}

const inForm = documents.filter(d => d.representable);
const summary = {
  artefacts: 'validation-1.3.17', saxon: 'Saxon-HE 12.5', ajv: JSON.parse(readFileSync(join(root, 'node_modules/ajv/package.json'), 'utf8')).version,
  environment: { node: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, loadAtStart, java: spawnSync(java, ['-version'], { encoding: 'utf8' }).stderr.split('\n')[0] },
  documents: documents.length, examples: documents.filter(d => !d.change).length, outsideForm: documents.filter(d => !d.representable).map(d => `${d.example}${d.change ? ` +${d.change}` : ''}`),
  agree: inForm.filter(d => d.agrees).length, compared: inForm.length,
  byRule: Object.fromEntries(RULES.map((rule, i) => [rule, {
    schematronFails: inForm.filter(d => d.schematronFailed.includes(rule)).length,
    agree: inForm.filter(d => d.schematronFailed.includes(rule) === d.jsonFailed.includes(rule)).length,
    bytes: Object.fromEntries(SYNTAXES.map(syntax => [syntax, single[syntax][i].bytes]))
  }])),
  schema: { ...Object.fromEntries(SYNTAXES.map(syntax => [syntax, { bytes: combined[syntax].bytes, compileMs: Math.round(combined[syntax].compileMs), prepareMs: Math.round(combined[syntax].prepareMs) }])),
    validateMedianMs: median(inForm.map(d => d.ajvMs)) },
  schematron: { ublCompileMs: schematron.ubl.compileMs, ciiCompileMs: schematron.cii.compileMs, validateMedianMs: median(documents.map(d => d.schematronMs)) },
  python: pythonResults,
  plainAjv,
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
  // One figure when both syntaxes have the same schema.
  const bothSizes = sizes => sizes.ubl === sizes.cii ? kB(sizes.ubl) : `${kB(sizes.ubl)} (UBL), ${kB(sizes.cii)} (CII)`;
  const seconds = value => `${(value / 1000).toFixed(0)} s`;
  const bySyntax = syntax => {
    const docs = inForm.filter(d => d.syntax === syntax);
    return `| ${syntax.toUpperCase()} | ${docs.filter(d => !d.change).length} | ${docs.filter(d => d.change).length} | ${docs.filter(d => d.schematronFailed.length).length} | ${docs.filter(d => d.agrees).length} of ${docs.length} |`;
  };
  const block = [
    '| Syntax | Examples | Changed copies | Rejected by the Schematron | Same verdict, rule by rule |',
    '|---|---:|---:|---:|---:|',
    ...SYNTAXES.map(bySyntax),
    '',
    '| Rule | Rejected by the Schematron | Same verdict | Schema for this rule alone |',
    '|---|---:|---:|---:|',
    ...RULES.map(rule => `| ${rule} | ${summary.byRule[rule].schematronFails} | ${summary.byRule[rule].agree} of ${inForm.length} | ${bothSizes(summary.byRule[rule].bytes)} |`),
    `| All seven | ${inForm.filter(d => d.schematronFailed.length).length} | ${inForm.filter(d => d.combinedValid === !d.schematronFailed.length).length} of ${inForm.length} | ${bothSizes(Object.fromEntries(SYNTAXES.map(syntax => [syntax, combined[syntax].bytes])))} |`,
    '',
    '| | Official Schematron (XSLT) | Compiled JSON Schema |',
    '|---|---:|---:|',
    `| Rules checked | All of EN 16931 | BR-CO-10 to BR-CO-16 |`,
    `| Size | ${kB(readFileSync(join(artefacts, 'ubl/xslt/EN16931-UBL-validation.xslt')).length)} (UBL), ${kB(readFileSync(join(artefacts, 'cii/xslt/EN16931-CII-validation.xslt')).length)} (CII) | ${kB(combined.ubl.bytes)} (UBL), ${kB(combined.cii.bytes)} (CII) |`,
    `| Preparation | ${ms(schematron.ubl.compileMs)} ms (UBL), ${ms(schematron.cii.compileMs)} ms (CII), Saxon-HE 12.5 | ${seconds(combined.ubl.prepareMs)} (UBL), ${seconds(combined.cii.prepareMs)} (CII), Ajv ${summary.ajv}, resources added bottom-up |`,
    `| Median validation | ${ms(summary.schematron.validateMedianMs)} ms | ${ms(summary.schema.validateMedianMs)} ms${pythonResults ? `; ${pythonResults.medianMs >= 1000 ? `${(pythonResults.medianMs / 1000).toFixed(1)} s` : `${ms(pythonResults.medianMs)} ms`} in Python jsonschema ${pythonResults.jsonschema}` : ''} |`,
    ...(pythonResults ? [`| Python \`jsonschema\`, default options | | same verdict on ${pythonResults.agree} of ${pythonResults.of} |`] : []),
    ...(plainAjv ?? []).map(({ options, syntax, compiled, ms, crashed, overflowed, agree, of }) => `| Ajv's own \`compile\`, ${options === 'default' ? 'default options' : '`inlineRefs: false`'}, ${syntax.toUpperCase()} | | ${!compiled ? 'overflows the stack while compiling'
      : `compiles in ${seconds(ms)}; ${crashed ? 'then overflows the stack while validating' : `${overflowed ? `${overflowed} of ${of} validations overflow the stack, ` : ''}same verdict on ${agree} of ${of}`}`} |`),
    '',
    `Measured on ${summary.environment.cpu}, ${summary.environment.platform}, Node ${process.version}, ${summary.environment.java}; medians of ${REPEAT} warm runs per invoice, excluding parsing. ` +
      `The one-minute load average was ${loadAtStart.toFixed(1)} on ${summary.environment.cores} cores when the run started${loadAtStart > summary.environment.cores / 2 ? ', from other work, so the times are likely higher than on an idle machine' : ''}.`
  ].join('\n');
  writeFileSync(page, text.replace(/<!-- results:start -->[\s\S]*<!-- results:end -->/, `<!-- results:start -->\n${block}\n<!-- results:end -->`));
}
process.exit(summary.agree === summary.compared && !summary.outsideForm.length ? 0 : 1);
