// Runs the generated corpora through independent JSON Schema validators in several
// languages, each with its default options, and compares every answer with the
// arithmetic. Run compat/setup.sh and `npm test` first. See compat/README.md.
//
//   node scripts/compat.mjs [--only id,id] [--write] [--require-all]
//
// --write merges the rows that ran into compat/results.json and regenerates the
// table in compat/README.md. The exit status is 1 if any validator gives a wrong
// answer or a runner fails to start, or if --require-all is set and one is not installed.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = `${root}bench/scratch/compat`;
// A runner reports when a schema has loaded and after every 100 records. It times out
// if it reports nothing for `limit` seconds, or spends `cap` seconds on one schema.
const limit = Number(process.env.COMPAT_TIMEOUT ?? 120);
const cap = Number(process.env.COMPAT_SCHEMA_CAP ?? 900);
const jobs = Number(process.env.COMPAT_JOBS ?? Math.max(1, Math.min(4, cpus().length >> 1)));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

const javaClasspath = () => `${root}compat/java/target/classes:${readFileSync(`${scratch}/java-classpath.txt`, 'utf8').trim()}`;
const python = `${scratch}/venv/bin/python`;
const js = name => ({ ready: existsSync(`${root}compat/js/node_modules`), command: [process.execPath, `${root}compat/js/run.mjs`, name] });
const py = name => ({ ready: existsSync(python), command: [python, '-I', `${root}compat/python/run.py`, name] });
const go = name => ({ ready: existsSync(`${scratch}/compat-go`), command: [`${scratch}/compat-go`, name] });
const java = name => ({
  ready: existsSync(`${scratch}/java-classpath.txt`),
  command: () => [process.env.COMPAT_JAVA ?? 'java', '-Xss16m', '-cp', javaClasspath(), 'Run', name],
});
const dotnet = name => ({ ready: existsSync(`${scratch}/dotnet/compat.dll`), command: ['dotnet', `${scratch}/dotnet/compat.dll`, name] });

// Order is the table's order. `option` marks a row that changes one default.
const runners = [
  { id: 'ajv', ...js('ajv') },
  { id: 'hyperjump', ...js('hyperjump') },
  { id: 'schemasafe', ...js('schemasafe') },
  { id: 'cfworker', ...js('cfworker') },
  { id: 'jsonschema', ...py('jsonschema') },
  { id: 'jsonschema-rs', ...py('jsonschema-rs') },
  { id: 'santhosh-tekuri', ...go('santhosh-tekuri') },
  { id: 'santhosh-tekuri-regexp2', ...go('santhosh-tekuri-regexp2'), option: 'ECMAScript regexp engine (dlclark/regexp2)' },
  { id: 'kaptinlin', ...go('kaptinlin') },
  { id: 'networknt', ...java('networknt') },
  { id: 'harrel', ...java('harrel') },
  { id: 'json-sKema', ...java('json-sKema') },
  { id: 'JsonSchema.Net', ...dotnet('JsonSchema.Net') },
  { id: 'JsonSchema.Net-depth', ...dotnet('JsonSchema.Net-depth'), option: 'JSON nesting limit raised from 64 to 256' },
].filter(runner => !only || only.includes(runner.id));

// The six schemas a visitor downloads, with the records shipped beside them.
mkdirSync(scratch, { recursive: true });
const examples = [];
for (const name of ['invoice', 'allocation', 'carry']) {
  for (const tally of [false, true]) {
    const file = suffix => JSON.parse(readFileSync(`${root}examples/${name}${tally ? '.tally' : ''}.${suffix}.json`, 'utf8'));
    examples.push({ name: `${name}${tally ? ' (tally)' : ''}`, schema: file('schema'), cases: [
      { data: file('valid'), expected: true }, { data: file('invalid'), expected: false }] });
  }
}
writeFileSync(`${scratch}/examples.json`, JSON.stringify(examples));
const suites = [
  { id: 'flat', title: 'Flat input', path: `${root}test/corpus.json` },
  { id: 'tally', title: 'Tally input', path: `${root}test/tally-corpus.json` },
  { id: 'examples', title: 'Shipped examples', path: `${scratch}/examples.json` },
];
for (const suite of suites) {
  if (!existsSync(suite.path)) throw new Error(`${suite.path} is missing; run npm test first.`);
  suite.groups = JSON.parse(readFileSync(suite.path, 'utf8')).map(({ name, cases }) => ({ name, cases: cases.length }));
}

// Runs one validator over one corpus. A timed-out runner is killed and the group is
// recorded as timed out while loading or validating; a crash is recorded against the
// group in progress. Either way the runner restarts at the next group.
async function runSuite(runner, suite) {
  const groups = new Array(suite.groups.length).fill(null);
  let header = null, first = 0;
  while (first < groups.length) {
    const [command, ...rest] = typeof runner.command === 'function' ? runner.command() : runner.command;
    const child = spawn(command, [...rest, suite.path, String(first)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', stderr = '', timedOut = null, loaded = false, timer, capTimer;
    const kill = reason => { timedOut = reason; child.kill('SIGKILL'); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => kill(loaded ? 'validating' : 'loading'), limit * 1000); };
    const startGroup = () => { loaded = false; clearTimeout(capTimer); capTimer = setTimeout(() => kill('total'), cap * 1000); };
    arm();
    startGroup();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const value = JSON.parse(line);
        if ('heartbeat' in value) loaded = true;
        else if ('index' in value) { groups[value.index] = value; startGroup(); }
        else header ??= value;
        arm();
      }
    });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    clearTimeout(capTimer);
    if (!header) return { header: null, startError: `exit ${code}: ${stderr.trim().slice(-500)}`, groups: [] };
    const missing = groups.findIndex((group, index) => index >= first && !group);
    if (missing < 0) break;
    groups[missing] = { index: missing, ...suite.groups[missing], falseAccepts: 0, falseRejects: 0, caseErrors: 0,
      error: timedOut ? null : `exited with ${code ?? 'a signal'}: ${stderr.trim().slice(-300)}`,
      timedOut, seconds: null };
    first = missing + 1;
  }
  return { header, groups };
}

function summarize(groups) {
  const loaded = groups.filter(group => !group.error && !group.timedOut);
  const sum = (list, key) => list.reduce((total, group) => total + (group[key] ?? 0), 0);
  const slowest = groups.reduce((a, b) => ((b.loadSeconds ?? 0) > (a.loadSeconds ?? 0) ? b : a), {});
  return {
    schemas: groups.length,
    loaded: loaded.length,
    refused: groups.filter(group => group.error).length,
    timedOut: groups.filter(group => group.timedOut).length,
    timedOutWhile: [...new Set(groups.filter(group => group.timedOut).map(group => group.timedOut))],
    cases: sum(groups, 'cases'),
    checked: sum(loaded, 'cases') - sum(loaded, 'caseErrors'),
    caseErrors: sum(loaded, 'caseErrors'),
    falseAccepts: sum(loaded, 'falseAccepts'),
    falseRejects: sum(loaded, 'falseRejects'),
    seconds: Math.round(sum(groups, 'seconds') * 10) / 10,
    slowestLoad: slowest.name ? { name: slowest.name, seconds: Math.round(slowest.loadSeconds * 10) / 10 } : null,
    errors: [...new Set(groups.filter(group => group.error).map(group => group.error))].slice(0, 3),
  };
}

function cell(s) {
  const number = n => n.toLocaleString('en-US');
  if (s.falseAccepts || s.falseRejects) return `**${number(s.falseAccepts + s.falseRejects)} wrong** (${s.falseAccepts} accepted, ${s.falseRejects} rejected)`;
  const problems = [s.refused && `refuses ${s.refused}`, s.timedOut && `times out on ${s.timedOut}`,
    s.caseErrors && `throws on ${s.caseErrors} records`].filter(Boolean);
  if (!s.loaded) return `${problems.join(', ')} of ${s.schemas}`;
  if (!problems.length) return `all ${number(s.checked)} agree`;
  return `${problems.join(', ')} of ${s.schemas} schemas; the other ${number(s.checked)} cases agree`;
}

const missing = runners.filter(runner => !runner.ready);
for (const runner of missing) console.log(`not run: ${runner.id} (run compat/setup.sh with its toolchain installed)`);
const queue = runners.filter(runner => runner.ready).flatMap(runner => suites.map(suite => ({ runner, suite })));
const done = new Map();
const failed = new Set();
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let task; (task = queue.shift());) {
    const { runner, suite } = task;
    const { header, groups, startError } = await runSuite(runner, suite);
    if (startError) {
      failed.add(runner.id);
      console.error(`${runner.id} ${suite.id}: runner did not start (${startError})`);
      continue;
    }
    const summary = summarize(groups);
    const entry = done.get(runner.id) ?? { id: runner.id, ...header, option: runner.option ?? null, suites: {} };
    delete entry.note;
    entry.suites[suite.id] = { ...summary, groups };
    done.set(runner.id, entry);
    console.log(`${runner.id.padEnd(24)} ${suite.id.padEnd(9)} ${cell(summary)} (${summary.seconds}s)`);
  }
}));
const rows = runners.filter(runner => done.has(runner.id) && !failed.has(runner.id)).map(runner => done.get(runner.id));

const wrong = rows.filter(row => Object.values(row.suites).some(s => s.falseAccepts || s.falseRejects));
if (args.includes('--write')) {
  const resultsPath = `${root}compat/results.json`;
  const previous = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : { rows: [] };
  const environment = { date: new Date().toISOString().slice(0, 10), platform: `${platform()}-${arch()}`,
    stallSeconds: limit, schemaCapSeconds: cap, jobs };
  const merged = new Map(previous.rows.map(row => [row.id, row]));
  for (const row of rows) merged.set(row.id, { ...row, environment });
  const order = runners.map(runner => runner.id);
  const all = [...merged.values()].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  writeFileSync(resultsPath, `${JSON.stringify({ suites: suites.map(({ id, title, groups }) => ({ id, title, schemas: groups.length,
    cases: groups.reduce((n, g) => n + g.cases, 0) })), rows: all }, null, 1)}\n`);
  const readmePath = `${root}compat/README.md`;
  const readme = readFileSync(readmePath, 'utf8');
  const head = `| Validator | Language | Version | ${suites.map(s => `${s.title} (${s.groups.length})`).join(' | ')} |`;
  const table = [head, `|---|---|---|${suites.map(() => '---').join('|')}|`, ...all.map(row =>
    `| ${row.validator}${row.option ? ` *with ${row.option}*` : ''} | ${row.language} | ${row.version} | ${suites.map(s => row.suites[s.id] ? cell(row.suites[s.id]) : 'not run').join(' | ')} |`)].join('\n');
  writeFileSync(readmePath, readme.replace(/(<!-- results:start -->\n)[\s\S]*?(\n?<!-- results:end -->)/, `$1${table}\n<!-- results:end -->`));
  console.log(`Wrote ${resultsPath} and the table in ${readmePath}.`);
}
if (wrong.length) console.error(`Wrong answers from: ${wrong.map(row => row.id).join(', ')}`);
if (failed.size) console.error(`Runner did not start: ${[...failed].join(', ')}`);
if (args.includes('--require-all') && missing.length) console.error(`Not installed: ${missing.map(r => r.id).join(', ')}`);
process.exit(wrong.length || failed.size || (args.includes('--require-all') && missing.length) ? 1 : 0);
