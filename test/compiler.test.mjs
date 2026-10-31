import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile } from '../src/compiler.mjs';
import { presets } from '../src/presets.mjs';
import { schemaResources, MAX_DEPTH, MAX_SUBSCHEMAS } from '../src/resources.mjs';
import { prepareValidator } from '../src/ajv-validator.mjs';
import { compileTally, encodeTally, decodeTally, MAX_TALLY_COPIES } from '../src/tally.mjs';
import { parseEquation, parseConstraint, normalizeSpec } from '../src/syntax.mjs';

const corpus = [];
const tallyCorpus = [];
function contract(name, spec, { tally = true } = {}) {
  const { schema } = compile(spec);
  const validator = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
  const group = { name, spec, schema, cases: [] };
  corpus.push(group);
  if (!tally) {
    return (data, expected) => {
      assert.equal(validator(data), expected, `${name}: ${JSON.stringify(data)}`);
      group.cases.push({ data, expected });
    };
  }
  const tallySchema = compileTally(spec).schema;
  const tallyValidator = new Ajv2020({ strict: true, inlineRefs: false }).compile(tallySchema);
  const tallyGroup = { name, schema: tallySchema, cases: [] };
  tallyCorpus.push(tallyGroup);
  return (data, expected) => {
    assert.equal(validator(data), expected, `${name}: ${JSON.stringify(data)}`);
    group.cases.push({ data, expected });
    let encoded;
    try { encoded = encodeTally(spec, data); }
    catch (error) {
      assert.equal(expected, false, `Unexpected representation error: ${error.message}`);
      return; // Malformed decimal source is checked before it has a wire encoding.
    }
    assert.deepEqual(decodeTally(spec, encoded), data);
    assert.equal(tallyValidator(encoded), expected, `tally ${name}: ${JSON.stringify(data)}`);
    tallyGroup.cases.push({ data: encoded, expected });
  };
}
const money = (minor, scale = 2) => {
  const text = String(minor).padStart(scale + 1, '0');
  return scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text;
};
let seed = 0x531ECA1C;
function random(limit) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % limit;
}

test('exhaustive one-digit addition, including overflow', () => {
  const check = contract('exhaustive addition', { fields: ['a', 'b', 'total'], constraints: ['total = a + b'], integerDigits: 1, scale: 0 });
  for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let total = 0; total < 10; total++) {
    check({ a: String(a), b: String(b), total: String(total) }, total === a + b);
  }
});

test('invoice agrees with an independent BigInt oracle', () => {
  const check = contract('invoice', presets.invoice.spec);
  check(presets.invoice.valid, true);
  check(presets.invoice.invalid, false);
  for (let i = 0; i < 350; i++) {
    const subtotal = BigInt(random(1000000)), shipping = BigInt(random(1000000)), discount = BigInt(random(1000000));
    const result = subtotal + shipping - discount;
    const total = result >= 0n && result < 1000000n ? result : BigInt(random(1000000));
    const row = { subtotal: money(subtotal), shipping: money(shipping), discount: money(discount), total: money(total) };
    check(row, total === result);
    const wrong = (total + 1n) % 1000000n;
    check({ ...row, total: money(wrong) }, wrong === result);
  }
});

test('every pair of two-digit addends, correct sums and one-unit errors', () => {
  const check = contract('exhaustive two-digit carries', { fields: ['a', 'b', 'total'], constraints: ['a + b = total'], integerDigits: 2, scale: 0 });
  for (let a = 0; a < 100; a++) for (let b = 0; b < 100; b++) {
    const sum = a + b;
    const total = sum % 100;
    check({ a: String(a), b: String(b), total: String(total) }, sum < 100);
    check({ a: String(a), b: String(b), total: String((total + 1) % 100) }, false);
  }
});

test('mixed-radix transitions agree with signed linear arithmetic', () => {
  // Coefficients and expected values are generated independently of the source parser.
  for (let i = 0; i < 16; i++) {
    const ca = random(7) - 3, cb = random(7) - 3, cc = random(7) - 3;
    const constant = random(19) - 9;
    const terms = [[ca, 'a'], [cb, 'b'], [cc, 'c']].flatMap(([c, name]) => Array.from({ length: Math.abs(c) }, () => `${c < 0 ? '-' : '+'} ${name}`));
    const equation = `result = 0 ${terms.join(' ')} ${constant < 0 ? '-' : '+'} ${Math.abs(constant)}`;
    const check = contract(`signed linear ${i}`, { fields: ['a', 'b', 'c', 'result'], constraints: [equation], integerDigits: 2, scale: 0 });
    for (let j = 0; j < 80; j++) {
      const a = random(30), b = random(30), c = random(30);
      const expected = BigInt(ca) * BigInt(a) + BigInt(cb) * BigInt(b) + BigInt(cc) * BigInt(c) + BigInt(constant);
      const result = expected >= 0n && expected < 100n ? expected : BigInt(random(100));
      check({ a: String(a), b: String(b), c: String(c), result: String(result) }, result === expected);
      const alternate = (result + 1n) % 100n;
      check({ a: String(a), b: String(b), c: String(c), result: String(alternate) }, alternate === expected);
    }
  }
});

test('cross-column carries, borrows, zero padding, and overflow', () => {
  const check = contract('carry chains', presets.carry.spec);
  for (const [a, b, result, expected] of [
    [99999n, 1n, 100000n, true], [99999n, 1n, 0n, false],
    [999999n, 1n, 0n, false], [999999n, 0n, 999999n, true],
    [0n, 0n, 0n, true], [1n, 9n, 10n, true], [9n, 91n, 100n, true],
    [9999n, 1n, 10000n, true], [1n, 0n, 0n, false]
  ]) check({ balance: money(a), deposit: money(b), result: money(result) }, expected);
});

test('constants and multiple simultaneous equations', () => {
  const check = contract('allocation', presets.allocation.spec);
  check(presets.allocation.valid, true); check(presets.allocation.invalid, false);
  const coupled = contract('coupled equations', { fields: ['a', 'b', 'c'], constraints: ['a + b = 1.00', 'c = a - b'], integerDigits: 2, scale: 2 });
  coupled({ a: '0.75', b: '0.25', c: '0.50' }, true);
  coupled({ a: '0.75', b: '0.25', c: '0.51' }, false);
  coupled({ a: '0.25', b: '0.75', c: '0.50' }, false);
  const overflow = contract('constant carry beyond width', { fields: ['a', 'b'], constraints: ['a + b = 9 + 9'], integerDigits: 1, scale: 0 });
  overflow({ a: '9', b: '9' }, true); overflow({ a: '1', b: '7' }, false);
  const reversed = contract('positive constant overflow', { fields: ['a', 'b'], constraints: ['9 + 9 = a + b'], integerDigits: 1, scale: 0 });
  reversed({ a: '9', b: '9' }, true); reversed({ a: '1', b: '7' }, false);
});

test('signed and repeated terms, cancellation, and constant-only equations', () => {
  const check = contract('repeated terms', { fields: ['a', 'b', 'c'], constraints: ['-a + b + b = c - 2'], integerDigits: 2, scale: 0 });
  for (let i = 0; i < 100; i++) {
    const a = random(100), b = random(50), c = -a + 2 * b + 2;
    if (c >= 0 && c < 100) check({ a: String(a), b: String(b), c: String(c) }, true);
    const candidate = random(100);
    check({ a: String(a), b: String(b), c: String(candidate) }, candidate === c);
  }
});

test('whole-number coefficients agree with an independent BigInt oracle', () => {
  // Coefficients and expected values are generated independently of the source parser.
  // 17 and above have no tally encoding; 1000 also overflowed Ajv's stack before region limits.
  const magnitudes = [2, 3, 7, 12, 16, 17, 100, 1000];
  for (let i = 0; i < magnitudes.length; i++) {
    const ca = magnitudes[i] * (i % 3 === 1 ? -1 : 1);
    const cb = (1 + random(16)) * (random(2) ? 1 : -1);
    const constant = random(41) - 20;
    const term = (c, name, swap) => `${c < 0 ? '-' : '+'} ${swap ? `${name} * ${Math.abs(c)}` : `${Math.abs(c)} * ${name}`}`;
    const equation = `result = ${term(ca, 'a', i % 2)} ${term(cb, 'b', i % 3 === 0)} ${constant < 0 ? '-' : '+'} ${money(Math.abs(constant), 1)}`;
    const spec = { fields: ['a', 'b', 'result'], constraints: [equation], integerDigits: 3, scale: 1 };
    const check = contract(`coefficients ${i}`, spec, { tally: Math.abs(ca) <= MAX_TALLY_COPIES });
    for (let j = 0; j < 80; j++) {
      // Keep each product within range half of the time, so that true cases occur.
      const bound = c => j % 2 ? Math.floor(10000 / Math.abs(c)) + 1 : 10000;
      const a = BigInt(random(bound(ca))), b = BigInt(random(bound(cb)));
      const expected = BigInt(ca) * a + BigInt(cb) * b + BigInt(constant);
      const result = expected >= 0n && expected < 10000n ? expected : BigInt(random(10000));
      check({ a: money(a, 1), b: money(b, 1), result: money(result, 1) }, result === expected);
      const alternate = (result + 1n) % 10000n;
      check({ a: money(a, 1), b: money(b, 1), result: money(alternate, 1) }, alternate === expected);
    }
  }
});

test('a coefficient means repeated terms, in either order', () => {
  const spec = normalizeSpec({ fields: ['a', 'b', 'c'], constraints: ['a = b'] });
  const terms = source => parseEquation(source, spec).terms;
  assert.deepEqual(terms('3 * a + b = c'), terms('a + a + a + b = c'));
  assert.deepEqual(terms('a*3 + b = c'), terms('3*a + b = c'));
  assert.deepEqual(terms('c - 2 * a = b'), [['a', -2], ['b', -1], ['c', 1]]);
  assert.deepEqual(terms('2 * a - a * 2 = 0'), []);
  assert.deepEqual(terms('1000 * a = c'), [['a', 1000], ['c', -1]]);
  const check = contract('coefficient and repetition', { fields: ['a', 'b'], constraints: ['16 * a = b + b'], integerDigits: 2, scale: 0 });
  for (let a = 0; a < 13; a++) for (const b of [8 * a, 8 * a + 1]) if (b < 100) check({ a: String(a), b: String(b) }, b === 8 * a);
});

const compare = { '=': (x, y) => x === y, '<=': (x, y) => x <= y, '>=': (x, y) => x >= y, '<': (x, y) => x < y, '>': (x, y) => x > y };

test('exhaustive one-digit inequalities', () => {
  for (const relation of ['<=', '>=', '<', '>']) {
    const check = contract(`exhaustive ${relation}`, { fields: ['a', 'b', 'total'], constraints: [`a + b ${relation} total`], integerDigits: 1, scale: 0 });
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let total = 0; total < 10; total++) {
      check({ a: String(a), b: String(b), total: String(total) }, compare[relation](a + b, total));
    }
  }
});

test('signed inequalities agree with an independent BigInt oracle, one unit either side', () => {
  // Coefficients, relations and expected values are generated independently of the source parser.
  for (let i = 0; i < 15; i++) {
    const relation = ['<=', '>=', '<', '>', '='][i % 5];
    const ca = random(11) - 5 || 1, cb = random(11) - 5 || -1, constant = random(41) - 20;
    const term = (c, name) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} * ${name}`;
    const equation = `${term(ca, 'a')} ${term(cb, 'b')} ${constant < 0 ? '-' : '+'} ${money(Math.abs(constant), 1)} ${relation} c`;
    const check = contract(`signed inequality ${i}`, { fields: ['a', 'b', 'c'], constraints: [equation], integerDigits: 2, scale: 1 });
    for (let j = 0; j < 60; j++) {
      // Half the time keep |ca a| + |cb b| below 1000, so both sides can be close.
      const bound = coefficient => j % 2 ? Math.floor(500 / Math.abs(coefficient)) : 1000;
      const a = BigInt(random(bound(ca))), b = BigInt(random(bound(cb)));
      const left = BigInt(ca) * a + BigInt(cb) * b + BigInt(constant);
      // Near the boundary where possible: the exact value and one unit either side.
      const near = left + BigInt(random(3) - 1);
      const c = j % 3 && near >= 0n && near < 1000n ? near : BigInt(random(1000));
      check({ a: money(a, 1), b: money(b, 1), c: money(c, 1) }, compare[relation](left, c));
    }
  }
});

test('inequalities at full precision, against constants and alongside equations', () => {
  const wide = contract('inequality 10.2', { fields: ['a', 'b'], constraints: ['a <= b'], integerDigits: 10, scale: 2 });
  for (const [a, b] of [[999999999999n, 999999999999n], [999999999999n, 999999999998n], [0n, 0n], [1n, 0n], [0n, 999999999999n], [500000000000n, 499999999999n]]) {
    wide({ a: money(a), b: money(b) }, a <= b);
  }
  const bounds = contract('constant bounds', { fields: ['fee'], constraints: ['fee >= 0.50', 'fee < 100', '2 * fee <= 150.00'], integerDigits: 3, scale: 2 });
  for (let fee = 0n; fee < 100000n; fee += 1n + BigInt(random(997))) bounds({ fee: money(fee) }, fee >= 50n && fee < 7501n);
  for (const fee of [49n, 50n, 7500n, 7501n, 9999n, 10000n]) bounds({ fee: money(fee) }, fee >= 50n && fee <= 7500n);
  const constants = contract('constant-only relations', { fields: ['a'], constraints: ['1 <= 2', '2 >= 2', '0 < 0.01', 'a >= 0'], integerDigits: 1, scale: 2 });
  constants({ a: '0.00' }, true); constants({ a: '9.99' }, true);
  const never = contract('false constant relation', { fields: ['a'], constraints: ['2 < 2'], integerDigits: 1, scale: 0 });
  never({ a: '0' }, false);
  const invoice = contract('invoice with a discount bound', { ...presets.invoice.spec, constraints: [...presets.invoice.spec.constraints, 'discount <= subtotal'] });
  invoice(presets.invoice.valid, true); invoice(presets.invoice.invalid, false);
  for (let i = 0; i < 200; i++) {
    const subtotal = BigInt(random(1000000)), shipping = BigInt(random(10000)), discount = BigInt(random(i % 2 ? 1000000 : Number(subtotal) + 2));
    const result = subtotal + shipping - discount;
    const total = result >= 0n && result < 1000000n ? result : BigInt(random(1000000));
    invoice({ subtotal: money(subtotal), shipping: money(shipping), discount: money(discount), total: money(total) }, total === result && discount <= subtotal);
  }
});

test('inequalities normalize to a sum at most zero', () => {
  const spec = normalizeSpec({ fields: ['a', 'b'], constraints: ['a = b'], scale: 2 });
  const parsed = source => { const { terms, constant, relation } = parseConstraint(source, spec); return { terms, constant, relation }; };
  assert.deepEqual(parsed('a <= b'), { terms: [['a', 1], ['b', -1]], constant: 0n, relation: '<=' });
  assert.deepEqual(parsed('a >= b + 1'), { terms: [['a', -1], ['b', 1]], constant: 100n, relation: '<=' });
  assert.deepEqual(parsed('a < b'), { terms: [['a', 1], ['b', -1]], constant: 1n, relation: '<=' });
  assert.deepEqual(parsed('a > 2 * b - 0.5'), { terms: [['a', -1], ['b', 2]], constant: -49n, relation: '<=' });
  assert.deepEqual(parsed('a = b'), { terms: [['a', 1], ['b', -1]], constant: 0n, relation: '=' });
  // The frozen benchmark compilers read every parsed result as an equality.
  assert.throws(() => parseEquation('a <= b', spec), /equality sign/);
});

test('tautologies still enforce field formats', () => {
  const check = contract('tautology', { fields: ['a'], constraints: ['a = a + 0'], integerDigits: 1, scale: 0 });
  check({ a: '0' }, true); check({ a: '9' }, true); check({ a: '10' }, false);
  const impossible = contract('contradiction', { fields: ['a'], constraints: ['1 = 2'], integerDigits: 1, scale: 0 });
  impossible({ a: '0' }, false);
});

test('malformed data cannot slip past arithmetic predicates', () => {
  // A tautology prevents arithmetic rejection from masking a faulty format check.
  const check = contract('strict domain', { ...presets.invoice.spec, constraints: ['subtotal = subtotal'] });
  for (const value of [127.5, null, true, {}, [], '-1.00', '01.00', '1', '1.0', '1.000', '1e2', ' 1.00', '1.00 ', '1.00\n', '1.00\r\n', '1.00\r', '1.00\u0085', '1.00\u2028', '1.00\u2029', '١.٠٠', '10000.00']) {
    check({ ...presets.invoice.valid, subtotal: value }, false);
  }
  const missing = { ...presets.invoice.valid }; delete missing.shipping;
  for (const data of [missing, { ...presets.invoice.valid, extra: '0.00' }, null, [], 'invoice']) check(data, false);
});

test('precision boundaries and zero fractional digits', () => {
  for (const [integerDigits, scale] of [[1, 4], [10, 2], [2, 0]]) {
    const spec = { fields: ['a', 'b'], constraints: ['a = b'], integerDigits, scale };
    const check = contract(`precision ${integerDigits}.${scale}`, spec);
    const maximum = 10n ** BigInt(integerDigits + scale) - 1n;
    check({ a: money(maximum, scale), b: money(maximum, scale) }, true);
    check({ a: money(0, scale), b: money(0, scale) }, true);
    check({ a: money(maximum, scale), b: money(maximum - 1n, scale) }, false);
  }
});

test('reject unsupported or ambiguous source syntax', () => {
  const base = { fields: ['a', 'b'], constraints: ['a = b'] };
  for (const equation of ['a == b', 'a = (b)', 'a = unknown', 'a =', '= b', 'a = 1.001', 'a = 10000', 'a = b; process.exit()', 'a + + b = 0']) {
    assert.throws(() => compile({ ...base, constraints: [equation] }), equation);
  }
  for (const [equation, message] of [
    ['a = b * b', /Fields cannot be multiplied together/], ['a * b = 0', /Fields cannot be multiplied together/],
    ['a = 1.5 * b', /whole number from 1 to 1000; found 1\.5/], ['a = 0 * b', /found 0\./], ['a = 02 * b', /found 02\./],
    ['a = 1001 * b', /found 1001\./], ['a = 2 * 3', /Multiply a field by a whole number/], ['a = 2b', /Write 2 \* b/],
    ['a = 2 * b * 3', /at most one coefficient/], ['a = b *', /Missing term/], ['a = * b', /found "\*"/], ['a = -2 * -b', /Multiply a field by a whole number/],
    ['a =< b', /found "<"/], ['a => b', /found ">"/], ['a <> b', /found ">"/], ['a < = b', /found "="/],
    ['a != b', /Use one relation/], ['a b', /Use one relation/], ['a <= b <= 1', /Unexpected token: <=/], ['a ≤ b', /Use one relation/]
  ]) assert.throws(() => compile({ ...base, constraints: [equation] }), message, equation);
  for (const bad of [{ fields: [] }, { fields: ['a', 'a'] }, { fields: ['__proto__'] }, { integerDigits: 0 }, { scale: 5 }, { integerDigits: 10, scale: 4 }, { constraints: [] }, { title: 42 }, { integerDigit: 3 }]) {
    assert.throws(() => compile({ ...base, ...bad }));
  }
});

test('output is deterministic, standard, and bounded', () => {
  const first = compile(presets.invoice.spec), second = compile(presets.invoice.spec);
  assert.deepEqual(first, second);
  assert.ok(first.stats.bytes < 42000, 'invoice should stay below 42 kB without compression');
  const text = JSON.stringify(first.schema);
  for (const extension of ['"$data"', '"$dynamicRef"', '"format"']) assert.ok(!text.includes(extension));
  assert.equal(first.stats.maxDigitTests, 96);
  // Default Ajv options must work too; inlineRefs:false is only a preparation-time preference.
  const validate = new Ajv2020().compile(first.schema);
  assert.equal(validate(presets.invoice.valid), true);
  assert.equal(validate(presets.invoice.invalid), false);
});

test('every reference resolves inside the self-contained standard schema document', () => {
  for (const preset of Object.values(presets)) {
    const { schema } = compile(preset.spec);
    const resources = schemaResources(schema);
    const uris = new Set(resources.map(r => r.uri));
    assert.equal(uris.size, resources.length, 'embedded resource identities are unique');
    const keywords = new Set(['$schema', '$id', 'title', 'type', 'required', 'additionalProperties', 'properties', 'pattern', 'allOf', 'not', 'if', 'then', 'else', '$ref', '$comment', '$defs']);
    function walk(node, base = schema.$id) {
      if (typeof node === 'boolean') return;
      if (node.$id) base = new URL(node.$id, base).href;
      for (const [key, value] of Object.entries(node)) {
        assert.ok(keywords.has(key), `unexpected schema keyword ${key}`);
        if (key === '$ref') {
          const uri = new URL(value, base).href;
          assert.ok(uri.startsWith(schema.$id));
          assert.ok(uris.has(uri), `unbundled reference ${uri}`);
        } else if (key === 'properties' || key === '$defs') Object.values(value).forEach(child => walk(child, base));
        else if (key === 'allOf') value.forEach(child => walk(child, base));
        else if (['not', 'if', 'then', 'else'].includes(key)) walk(value, base);
      }
    }
    walk(schema);
  }
});

test('flat schemas avoid regex lookaround and stay within parser depth and size limits', () => {
  // RE2 has no lookaround; System.Text.Json reads 64 levels by default, and networknt slows sharply with depth.
  const depth = value => value && typeof value === 'object' ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0;
  // Subschemas reachable without crossing a $ref, which Ajv compiles into one function.
  const region = node => !node || typeof node !== 'object' ? 1 : 1 + Object.entries(node).reduce((n, [key, value]) =>
    n + (['if', 'then', 'else', 'not'].includes(key) ? region(value)
      : ['allOf', 'properties'].includes(key) ? Object.values(value).reduce((m, child) => m + region(child), 0) : 0), 0);
  const largestRegion = schema => Math.max(region(schema), ...Object.values(schema.$defs ?? {}).map(region));
  const patterns = new Set();
  for (const { name, schema } of corpus) {
    assert.ok(depth(schema) <= MAX_DEPTH, `${name} nests ${depth(schema)} levels`);
    assert.ok(largestRegion(schema) <= MAX_SUBSCHEMAS, `${name} has ${largestRegion(schema)} subschemas in one region`);
    JSON.stringify(schema, (key, value) => (key === 'pattern' && patterns.add(value), value));
  }
  for (const pattern of patterns) assert.doesNotMatch(pattern, /\(\?[=!<]/);
  const check = (group, schema) => {
    const validate = new Ajv2020({ strict: true }).compile(schema);
    for (const { data, expected } of group.cases) assert.equal(validate(data), expected, `${group.name}: ${JSON.stringify(data)}`);
  };
  // A small limit moves many subschemas, including unshared ones, into $defs.
  for (const group of corpus.filter(g => depth(g.schema) > 24)) {
    const { schema } = compile(group.spec, { maxDepth: 8 });
    assert.ok(depth(schema) <= 8);
    check(group, schema);
  }
  for (const group of corpus.filter(g => largestRegion(g.schema) > 1000).slice(0, 4)) {
    const { schema } = compile(group.spec, { maxSubschemas: 50 });
    assert.ok(largestRegion(schema) <= 50);
    check(group, schema);
  }
  // The defs layout declares every resource directly in root $defs, none inside another.
  const ids = value => JSON.stringify(value).split('"$id"').length - 1;
  for (const group of corpus) {
    const { schema } = compile(group.spec, { layout: 'defs' });
    assert.equal(ids({ ...schema, $defs: {} }), 1);
    for (const resource of Object.values(schema.$defs ?? {})) assert.equal(ids(resource), 1);
    check(group, schema);
  }
  assert.throws(() => compile(presets.invoice.spec, { layout: 'nested' }), /Unknown layout/);
});

test('browser preparation avoids deep compiler recursion', () => {
  execFileSync(process.execPath, ['--stack_size=256', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {compile} from './src/compiler.mjs';
    import {presets} from './src/presets.mjs';
    import {prepareValidator} from './src/ajv-validator.mjs';
    const validate = prepareValidator(compile(presets.invoice.spec).schema);
    assert.equal(validate(presets.invoice.valid), true);
    assert.equal(validate(presets.invoice.invalid), false);
  `], { cwd: new URL('../', import.meta.url), stdio: 'pipe' });
});

test('browser preparation preserves the entire independent arithmetic corpus', () => {
  for (const group of corpus) {
    const validate = prepareValidator(group.schema);
    for (const { data, expected } of group.cases) {
      assert.equal(validate(data), expected, `${group.name}: ${JSON.stringify(data)}`);
    }
  }
});

test('different contracts can coexist in one standard validator registry', () => {
  const a = compile(presets.invoice.spec).schema;
  const b = compile(presets.allocation.spec).schema;
  assert.notEqual(a.$id, b.$id);
  const ajv = new Ajv2020({ strict: true, inlineRefs: false });
  ajv.addSchema(a); ajv.addSchema(b);
  assert.equal(ajv.getSchema(a.$id)(presets.invoice.valid), true);
  assert.equal(ajv.getSchema(b.$id)(presets.allocation.invalid), false);
});

test('tally representation rejects malformed wire data and forged constants', () => {
  function fixture(name, spec, record) {
    const { schema } = compileTally(spec);
    const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
    const group = { name, schema, cases: [] }; tallyCorpus.push(group);
    const encoded = encodeTally(spec, record);
    return { encoded, check(data, expected) {
      assert.equal(validate(data), expected, name);
      group.cases.push({ data, expected });
    } };
  }
  const { encoded, check } = fixture('malformed tally domain', presets.invoice.spec, presets.invoice.valid);
  check(encoded, true);
  for (const bad of [null, true, [], {}, presets.invoice.valid, { ...encoded, extra: 0 }, { d: encoded.d },
    { ...encoded, d: encoded.d.slice(1) }, { ...encoded, d: [...encoded.d, 1] }, { ...encoded, $: null }]) check(bad, false);
  for (const token of [0, 2, 1.5, true, null, '1', {}, []]) {
    const bad = structuredClone(encoded); bad.d[0] = token; check(bad, false);
  }
  const extra = structuredClone(encoded);
  let end = extra; while (end.$ !== null) end = end.$;
  end.$ = structuredClone(end); check(extra, false);
  const permuted = structuredClone(encoded);
  for (let row = permuted; row !== null; row = row.$) {
    for (let i = 0; i < row.d.length; i += 9) row.d.splice(i, 9, ...row.d.slice(i, i + 9).toReversed());
  }
  check(permuted, true);
  assert.deepEqual(decodeTally(presets.invoice.spec, permuted), presets.invoice.valid);

  // Change the literal 100.00 to 100.01 and change an input to match it. The
  // arithmetic would pass, but the schema must reject the forged contract data.
  const allocation = fixture('forged literal tally', presets.allocation.spec,
    { research: '33.34', engineering: '33.33', operations: '33.34' });
  allocation.check(allocation.encoded, false);
  allocation.encoded.d[27] = 4;
  allocation.check(allocation.encoded, false);
  assert.throws(() => decodeTally(presets.allocation.spec, allocation.encoded));

  // Fake two copies of a repeated field as different values: 2 + 3 = 5.
  // Likewise, two equations may not read different copies of a shared field.
  const spec = { fields: ['a', 'total'], constraints: ['a + a = total', 'a = 2'], integerDigits: 1, scale: 0 };
  const duplicate = fixture('forged repeated field tally', spec, { a: '2', total: '5' });
  duplicate.encoded.d[11] = 2;
  duplicate.check(duplicate.encoded, false);
  assert.throws(() => decodeTally(spec, duplicate.encoded));
});

test('tally compiler is compact, deterministic, self-contained and uses only standard keywords', () => {
  const result = compileTally(presets.invoice.spec);
  assert.deepEqual(result, compileTally(presets.invoice.spec));
  assert.ok(result.stats.bytes < 4200);
  const allowed = new Set(['$schema', '$defs', '$ref', '$comment', 'title', 'type', 'allOf', 'if', 'then', 'else',
    'properties', 'required', 'additionalProperties', 'prefixItems', 'items', 'minItems', 'maxItems',
    'contains', 'minContains', 'maxContains', 'enum', 'const']);
  for (const { schema } of tallyCorpus) {
    function walk(node) {
      if (typeof node === 'boolean') return;
      for (const [key, value] of Object.entries(node)) {
        assert.ok(allowed.has(key), key);
        if (key === '$ref') assert.ok(value.startsWith('#/$defs/') && Object.hasOwn(schema.$defs, value.slice(8)));
        else if (['$defs', 'properties'].includes(key)) Object.values(value).forEach(walk);
        else if (['allOf', 'prefixItems'].includes(key)) value.forEach(walk);
        else if (['if', 'then', 'else', 'items', 'contains'].includes(key)) walk(value);
      }
    }
    walk(schema);
  }
  const validate = new Ajv2020().compile(result.schema);
  assert.equal(validate(encodeTally(presets.invoice.spec, presets.invoice.valid)), true);
  assert.equal(validate(encodeTally(presets.invoice.spec, presets.invoice.invalid)), false);
  const prepared = prepareValidator(result.schema);
  assert.equal(prepared(encodeTally(presets.invoice.spec, presets.invoice.valid)), true);
  execFileSync(process.execPath, ['--stack_size=256', '--input-type=module', '-e', `
    import { compileTally, encodeTally } from './src/tally.mjs';
    import { presets } from './src/presets.mjs';
    import { prepareValidator } from './src/ajv-validator.mjs';
    if (!prepareValidator(compileTally(presets.invoice.spec).schema)(encodeTally(presets.invoice.spec, presets.invoice.valid))) process.exit(1);
  `], { cwd: new URL('../', import.meta.url), stdio: 'pipe' });
});

test('the tally encoding refuses coefficients above sixteen', () => {
  const spec = constraints => ({ fields: ['a', 'b'], constraints, integerDigits: 2, scale: 0 });
  assert.ok(compileTally(spec([`${MAX_TALLY_COPIES} * a = b`])).stats.bytes > 0);
  for (const constraints of [['17 * a = b'], ['a * 9 + 8 * a = b'], ['a = b', '-17 * b = a - 99']]) {
    assert.throws(() => compileTally(spec(constraints)), /tally encoding supports coefficients up to 16/);
    assert.throws(() => encodeTally(spec(constraints), { a: '0', b: '0' }), /tally encoding/);
    assert.ok(compile(spec(constraints)).stats.bytes > 0);
  }
});

test('tally arithmetic scales to twelve digits and the sixteen-term limit', () => {
  const cases = [
    [{ fields: ['a', 'b', 'total'], constraints: ['a + b = total'], integerDigits: 10, scale: 2 },
      { a: '9999999999.98', b: '0.01', total: '9999999999.99' }, { a: '9999999999.99', b: '0.01', total: '0.00' }],
    [{ fields: ['a', 'total'], constraints: [`${Array(15).fill('a').join(' + ')} = total`], integerDigits: 2, scale: 0 },
      { a: '6', total: '90' }, { a: '7', total: '5' }]
  ];
  for (const [spec, good, bad] of cases) {
    const { schema } = compileTally(spec);
    const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
    const group = { name: `tally stress ${spec.integerDigits}.${spec.scale}`, schema, cases: [] };
    tallyCorpus.push(group);
    for (const [record, expected] of [[good, true], [bad, false]]) {
      const data = encodeTally(spec, record);
      assert.deepEqual(decodeTally(spec, data), record);
      assert.equal(validate(data), expected);
      group.cases.push({ data, expected });
    }
  }
});

test('write independently checkable cross-validator corpora', async () => {
  await writeFile(new URL('corpus.json', import.meta.url), JSON.stringify(corpus));
  console.log(`Cross-validator corpus: ${corpus.reduce((n, g) => n + g.cases.length, 0)} cases across ${corpus.length} schemas.`);
  await writeFile(new URL('tally-corpus.json', import.meta.url), JSON.stringify(tallyCorpus));
  console.log(`Tally cross-validator corpus: ${tallyCorpus.reduce((n, g) => n + g.cases.length, 0)} cases across ${tallyCorpus.length} schemas.`);
});
