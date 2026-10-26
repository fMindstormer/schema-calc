import { prepareValidator } from '../src/ajv-validator.mjs';
import { compile } from '../src/compiler.mjs';
import { compileTally, encodeTally } from '../src/tally.mjs';

let cached;
self.onmessage = ({ data: { id, spec, record, encoding = 'flat' } }) => {
  let phase = 'compile';
  try {
    const signature = JSON.stringify([encoding, spec]);
    if (cached?.signature !== signature) {
      const start = performance.now();
      const output = (encoding === 'tally' ? compileTally : compile)(spec);
      const compiled = performance.now();
      phase = 'prepare';
      const validate = prepareValidator(output.schema);
      cached = { signature, ...output, validate, compileMs: compiled - start, prepareMs: performance.now() - compiled };
    }
    phase = 'encode';
    const encodingStart = performance.now();
    let payload;
    try { payload = encoding === 'tally' ? encodeTally(spec, record) : record; }
    catch (error) {
      self.postMessage({ id, valid: false, encoding, encodingError: error.message, errors: [],
        stats: cached.stats, compileMs: cached.compileMs, prepareMs: cached.prepareMs, validationMs: 0, encodeMs: performance.now() - encodingStart, schema: cached.schema });
      return;
    }
    const encodeMs = performance.now() - encodingStart;
    phase = 'validate';
    const start = performance.now();
    // All record validation is performed by unmodified Ajv against the generated schema.
    const valid = cached.validate(payload);
    const validationMs = performance.now() - start;
    // Include the artifact even for cache hits: the UI may have discarded an earlier reply.
    self.postMessage({ id, valid, encoding, payload, encodeMs, errors: cached.validate.errors ?? [], stats: cached.stats, compileMs: cached.compileMs, prepareMs: cached.prepareMs, validationMs, schema: cached.schema });
  } catch (error) {
    self.postMessage({ id, error: error.message, phase, stack: error.stack });
  }
};
