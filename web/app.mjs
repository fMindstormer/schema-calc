import { presets } from '../src/presets.mjs';
import { nudgeField } from '../src/nudge.mjs';
import { normalizeSpec } from '../src/syntax.mjs';
const $ = id => document.getElementById(id);
const worker = new Worker('./worker.js', { type: 'module' });
const RECORD_HELP = 'Amounts are strings. A single wrong cent should fail.';
let id = 0, timer, selected = 'invoice', schema, payload;
function setState(state, title, description) {
  $('result').dataset.state = state;
  $('status-title').textContent = title;
  $('status-description').textContent = description;
}
function disableDownload() { $('download').disabled = true; $('download-record').disabled = true; }
const tally = () => $('encoding').value === 'tally';
const schemaName = () => `${selected}${tally() ? '.tally' : ''}.schema.json`;
const recordName = () => `${selected}${tally() ? '.tally' : ''}.record.json`;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const size = n => n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} kB`;
function tamperResult() {
  try { return nudgeField(JSON.parse($('contract').value), JSON.parse($('record').value), presets[selected].tamper); }
  catch { return { reason: 'the contract and record must be valid JSON' }; }
}
function updateTamper() {
  const { reason } = tamperResult();
  $('tamper').disabled = Boolean(reason);
  $('record-help').textContent = reason ? `${presets[selected].tamper.label} is unavailable: ${reason}.` : RECORD_HELP;
}
// What the downloaded schema accepts, stated from the contract that produced it.
function boundaries(spec) {
  const { integerDigits, scale } = normalizeSpec(spec);
  const range = `${'0'}${scale ? '.' + '0'.repeat(scale) : ''}–${'9'.repeat(integerDigits)}${scale ? '.' + '9'.repeat(scale) : ''}`;
  const digits = scale ? `exactly ${['one', 'two', 'three', 'four'][scale - 1]} fractional digit${scale > 1 ? 's' : ''}` : 'whole numbers only';
  return tally()
    ? `Converted tally JSON, not decimal strings · values ${range} · ${digits} · one column per digit · extra properties rejected`
    : `Decimal strings · ${range} · ${digits} · all declared fields required · extra fields rejected`;
}
function updateHandoff(valid) {
  $('handoff-command').textContent = `python3 -m pip install jsonschema==4.25.1\npython3 validate.py ${schemaName()} ${recordName()}`;
  $('handoff-expected').textContent = valid === undefined ? '—' : `${valid ? 'ACCEPT' : 'REJECT'}  ${recordName()}`;
  $('handoff-note').textContent = tally()
    ? 'Tally mode: this schema checks the converted validation JSON from “Download tally record”, not your decimal record. The original record is rejected by this schema.'
    : 'In tally mode the schema checks converted validation JSON instead, so download its tally record as well.';
  $('download-record-label').textContent = tally() ? 'Download tally record' : 'Download record';
}
function run() {
  const current = ++id;
  disableDownload();
  updateTamper();
  $('error-details').hidden = true;
  try {
    let spec, record;
    try { spec = JSON.parse($('contract').value); } catch (e) { throw new Error(`Contract JSON: ${e.message}`); }
    try { record = JSON.parse($('record').value); } catch (e) { throw new Error(`Record JSON: ${e.message}`); }
    setState('pending', 'Checking…', 'Compiling the contract and checking this record with Ajv.');
    worker.postMessage({ id: current, spec, record, encoding: $('encoding').value });
  } catch (error) {
    setState('error', 'Check your JSON', error.message);
    clearMetrics();
  }
}
function clearMetrics() {
  for (const field of ['schema-size', 'record-size', 'node-count', 'steps', 'timing', 'boundaries']) $(field).textContent = '—';
  schema = undefined;
  payload = undefined;
  $('schema-preview').textContent = 'No schema available for the current input.';
  $('compile-time').textContent = '';
  $('timing-note').textContent = '';
  $('payload-preview').textContent = 'No validation JSON available for the current input.';
  updateHandoff();
}
function schedule() {
  ++id; disableDownload(); clearTimeout(timer);
  updateTamper();
  setState('pending', 'Checking…', 'Waiting for your edit.');
  timer = setTimeout(run, 250);
}
worker.onmessage = ({ data }) => {
  if (data.id !== id) return;
  if (data.error) {
    setState('error', data.phase === 'prepare' ? 'Validator could not prepare the schema' : 'Contract could not compile', data.error);
    $('error-details').hidden = false;
    $('validator-errors').textContent = data.stack || data.error;
    clearMetrics(); return;
  }
  if (data.schema) {
    schema = data.schema;
    $('schema-preview').textContent = JSON.stringify(schema, null, 2);
  }
  $('download').disabled = !schema;
  payload = data.payload;
  $('download-record').disabled = payload === undefined;
  $('payload-preview').textContent = payload === undefined ? data.encodingError : JSON.stringify(payload, null, 2);
  $('boundaries').textContent = boundaries(JSON.parse($('contract').value));
  $('schema-size').textContent = size(data.stats.bytes);
  $('record-size').textContent = payload === undefined ? '—' : size(bytes(payload));
  $('node-label').textContent = data.encoding === 'tally' ? 'CARRY STATES' : 'DECISION NODES';
  $('steps-label').textContent = data.encoding === 'tally' ? 'COUNT TESTS / RECORD' : 'DIGIT TESTS / RECORD';
  $('node-count').textContent = (data.stats.arithmeticStates ?? data.stats.decisionNodes).toLocaleString();
  $('steps').textContent = `≤ ${data.stats.maxCountTests ?? data.stats.maxDigitTests}`;
  $('timing').textContent = `${data.validationMs < 0.01 ? '<0.01' : data.validationMs.toFixed(2)} ms`;
  $('compile-time').textContent = `Compiler: ${data.compileMs.toFixed(1)} ms · Ajv preparation: ${data.prepareMs.toFixed(1)} ms${data.encoding === 'tally' ? ` · Encoding: ${data.encodeMs.toFixed(2)} ms` : ''}. Validation time is one local run, not a benchmark.`;
  // Constant markup only; no user input reaches innerHTML.
  $('timing-note').innerHTML = data.encoding === 'tally'
    ? 'This page validates the same tally schema you download; encoding the record is timed separately.'
    : 'To cut preparation time, this page gives Ajv an in-memory unbundled copy of the schema; the download is the packed file itself. Smaller is not faster: in both tested validators the packed default validates more slowly than the larger mixed-radix schema (<a href="https://github.com/fMindstormer/schema-calc#smallest-is-not-fastest" target="_blank" rel="noreferrer">measurements</a>).';
  if (data.encodingError) { setState('invalid', 'Record cannot be encoded', data.encodingError); updateHandoff(); return; }
  updateHandoff(data.valid);
  if (data.valid) setState('valid', 'Record accepted', 'Every field has the right format, and every declared equation holds.');
  else {
    const shapeError = data.errors.find(e => ['type', 'required', 'additionalProperties'].includes(e.keyword) || (e.keyword === 'pattern' && e.schemaPath.startsWith('#/properties/')));
    setState('invalid', 'Record rejected', shapeError ? `${shapeError.instancePath || 'Record'} ${shapeError.message}.` : 'A declared equation or field format does not hold. The generated schema rejected this record.');
    $('error-details').hidden = false;
    $('validator-errors').textContent = JSON.stringify(data.errors, null, 2);
  }
};
worker.onerror = () => { setState('error', 'Validator could not start', 'Reload the page. If this persists, run npm run build again.'); disableDownload(); };
function loadPreset(name) {
  selected = name;
  const preset = presets[name];
  // Keep the equation visible without scrolling inside the source editor.
  $('contract').value = JSON.stringify(preset.spec, null, 2).replace(/\[\n\s+([^\]]+)\n\s+\]/g, (_, items) => `[${items.replace(/\n\s*/g, ' ')}]`);
  $('record').value = JSON.stringify(preset.valid, null, 2);
  $('tamper').textContent = preset.tamper.label;
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === name)));
  clearTimeout(timer); run();
}
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => loadPreset(button.dataset.preset)));
for (const field of ['contract', 'record']) $(field).addEventListener('input', schedule);
$('encoding').addEventListener('change', () => {
  $('encoding-help').textContent = tally()
    ? 'Smaller schema, different JSON format. The digit encoder preserves your supplied values, including an incorrect total. Download both files to validate elsewhere.'
    : 'Validates the decimal-string record exactly as shown above.';
  clearTimeout(timer); updateHandoff(); run();
});
// Changes only the preset's field in the record as currently edited, by an exact decimal amount.
$('tamper').addEventListener('click', () => {
  const { record } = tamperResult();
  if (!record) return;
  $('record').value = JSON.stringify(record, null, 2); clearTimeout(timer); run();
});
$('reset').addEventListener('click', () => loadPreset(selected));
function save(value, name, type) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value) + '\n'], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').addEventListener('click', () => { if (schema) save(schema, schemaName(), 'application/schema+json'); });
$('download-record').addEventListener('click', () => { if (payload !== undefined) save(payload, recordName(), 'application/json'); });
$('copy-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('handoff-command').textContent); $('copy-command').textContent = 'Copied'; }
  catch { $('copy-command').textContent = 'Select and copy'; }
  setTimeout(() => { $('copy-command').textContent = 'Copy'; }, 1500);
});
loadPreset('invoice');
