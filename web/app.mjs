import { presets } from '../src/presets.mjs';
const $ = id => document.getElementById(id);
const worker = new Worker('./worker.js', { type: 'module' });
let id = 0, timer, selected = 'invoice', schema, payload;
function setState(state, title, description) {
  $('result').dataset.state = state;
  $('status-title').textContent = title;
  $('status-description').textContent = description;
}
function disableDownload() { $('download').disabled = true; $('download-record').disabled = true; }
function run() {
  const current = ++id;
  disableDownload();
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
  for (const field of ['schema-size', 'node-count', 'steps', 'timing']) $(field).textContent = '—';
  schema = undefined;
  payload = undefined;
  $('schema-preview').textContent = 'No schema available for the current input.';
  $('compile-time').textContent = '';
  $('payload-preview').textContent = 'No validation JSON available for the current input.';
}
function schedule() {
  ++id; disableDownload(); clearTimeout(timer);
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
  $('schema-size').textContent = `${(data.stats.bytes / 1000).toFixed(1)} kB`;
  $('node-label').textContent = data.encoding === 'tally' ? 'CARRY STATES' : 'DECISION NODES';
  $('steps-label').textContent = data.encoding === 'tally' ? 'COUNT TESTS / RECORD' : 'DIGIT TESTS / RECORD';
  $('node-count').textContent = (data.stats.arithmeticStates ?? data.stats.decisionNodes).toLocaleString();
  $('steps').textContent = `≤ ${data.stats.maxCountTests ?? data.stats.maxDigitTests}`;
  $('timing').textContent = `${data.validationMs < 0.01 ? '<0.01' : data.validationMs.toFixed(2)} ms`;
  $('compile-time').textContent = `Compiler: ${data.compileMs.toFixed(1)} ms · Ajv preparation: ${data.prepareMs.toFixed(1)} ms${data.encoding === 'tally' ? ` · Encoding: ${data.encodeMs.toFixed(2)} ms` : ''}. Validation time is one local run, not a benchmark.`;
  if (data.encodingError) { setState('invalid', 'Record cannot be encoded', data.encodingError); return; }
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
  $('tamper').textContent = preset.invalidLabel;
  document.querySelectorAll('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === name)));
  clearTimeout(timer); run();
}
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => loadPreset(button.dataset.preset)));
for (const field of ['contract', 'record']) $(field).addEventListener('input', schedule);
$('encoding').addEventListener('change', () => {
  $('encoding-help').textContent = $('encoding').value === 'tally'
    ? 'Smaller schema, different JSON format. The digit encoder preserves your supplied values, including an incorrect total. Download both files to validate elsewhere.'
    : 'Validates the decimal-string record exactly as shown above.';
  clearTimeout(timer); run();
});
$('tamper').addEventListener('click', () => { $('record').value = JSON.stringify(presets[selected].invalid, null, 2); clearTimeout(timer); run(); });
$('reset').addEventListener('click', () => loadPreset(selected));
$('download').addEventListener('click', () => {
  if (!schema) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(schema) + '\n'], { type: 'application/schema+json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${selected}${$('encoding').value === 'tally' ? '.tally' : ''}.schema.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('download-record').addEventListener('click', () => {
  if (payload === undefined) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${selected}.${$('encoding').value}.record.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
loadPreset('invoice');
