import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compiler.mjs';
import { compileTally, encodeTally } from '../src/tally.mjs';
import { prepareValidator } from '../src/ajv-validator.mjs';
import { describeFailures } from '../src/failures.mjs';
import { normalizeSpec, parseRule } from '../src/syntax.mjs';

let seed = 0x0F41105;
const draw = limit => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return Math.floor(seed / 2 ** 32 * limit);
};
const pick = values => values[draw(values.length)];

// A value of the declared format, or occasionally one of many malformed ones.
function amount(spec, max = 10 ** spec.integerDigits) {
  if (!draw(40)) return pick([null, 1, '', ' 1', '01', '1.', '-', '--1', 'x', '1e1', '9'.repeat(spec.integerDigits + 1)]);
  const units = draw(max * 10 ** spec.scale) * (spec.signed && draw(2) ? -1 : 1);
  const text = String(Math.abs(units)).padStart(spec.scale + 1, '0');
  return `${units < 0 ? '-' : ''}${spec.scale ? `${text.slice(0, -spec.scale)}.${text.slice(-spec.scale)}` : text}`;
}
function record(raw, max) {
  const spec = normalizeSpec(raw), result = {};
  for (const field of spec.fields) {
    if (spec.optional?.includes(field) && draw(3) === 0) continue;
    result[field] = spec.values?.[field] && draw(8) ? pick(spec.values[field]) : amount(spec, max);
  }
  for (const [name, { maxItems, fields, optional = [], values = {} }] of Object.entries(spec.lists)) {
    result[name] = Array.from({ length: draw(maxItems + 2) }, () => Object.fromEntries(fields
      .filter(field => !optional.includes(field) || draw(3))
      .map(field => [field, values[field] && draw(8) ? pick(values[field]) : amount(spec, max)])));
  }
  if (!draw(30)) delete result[pick(Object.keys(result))];
  if (!draw(30)) result.extra = '1';
  return result;
}

// What a report should say, from schemas compiled from one constraint at a time: the
// format, from the constraint `field = field`, which checks nothing else, and each
// constraint on its own, applied to each line alone for a constraint on each line.
// compileOne returns a check of the original record, which it encodes as its own
// contract needs: a tally record has blocks for that contract's constants.
function oracle(raw, compileOne) {
  const spec = normalizeSpec(raw);
  const tautology = spec.fields.length ? `${spec.fields[0]} = ${spec.fields[0]}` : `sum(${Object.keys(spec.lists)[0]}) = sum(${Object.keys(spec.lists)[0]})`;
  const format = compileOne({ ...raw, constraints: [tautology] });
  const constraints = raw.constraints.map((entry, i) => ({ source: spec.constraints[i], name: spec.names?.[i] ?? undefined,
    list: parseRule(spec.constraints[i], spec).each ?? null, validate: compileOne({ ...raw, constraints: [entry] }) }));
  // The report lists constraints on the record before those on each line.
  const ordered = [...constraints.filter(c => !c.list), ...Object.keys(spec.lists).flatMap(list => constraints.filter(c => c.list === list))];
  return data => {
    if (!format(data)) return 'format';
    return ordered.flatMap(({ source, name, list, validate }) => {
      if (!list) return validate(data) ? [] : [{ source, ...(name && { name }) }];
      const items = data[list].flatMap((line, i) => validate({ ...data, [list]: [line] }) ? [] : [i]);
      return items.length ? [{ source, ...(name && { name }), list, items }] : [];
    });
  };
}

function agree(name, raw, { options, tally = false, records = 400, max } = {}) {
  const schema = tally ? compileTally(raw).schema : compile(raw, options).schema;
  const validate = prepareValidator(schema);
  const encode = tally ? data => encodeTally(raw, data) : data => data;
  const compileOne = spec => {
    const check = prepareValidator(tally ? compileTally(spec).schema : compile(spec, options).schema);
    return tally ? data => check(encodeTally(spec, data)) : check;
  };
  const expect = oracle(raw, compileOne);
  const seen = { format: 0, constraints: 0, accepted: 0 };
  for (let n = 0; n < records; n++) {
    const data = record(raw, max);
    // The tally encoder refuses a malformed record before there is a tally record.
    try { encode(data); } catch { continue; }
    const expected = expect(data), accepted = validate(encode(data)), report = validate.failures(encode(data));
    const label = `${name}: ${JSON.stringify(data)}`;
    if (expected === 'format') {
      assert.equal(accepted, false, label);
      assert.ok(report.format.length && !report.constraints.length, label);
      seen.format++;
    } else {
      assert.equal(accepted, !expected.length, label);
      assert.deepEqual(report, { format: [], constraints: expected }, label);
      seen[expected.length ? 'constraints' : 'accepted']++;
    }
  }
  // Each kind of verdict occurs, so the comparison is not vacuous. A tally record is
  // well formed unless someone changes it after encoding.
  assert.ok((seen.format || tally) && seen.constraints && seen.accepted, `${name}: ${JSON.stringify(seen)}`);
  return schema;
}

const invoice = {
  fields: ['subtotal', 'shipping', 'discount', 'total'], integerDigits: 2, scale: 1,
  constraints: [{ name: 'Total', constraint: 'total = subtotal + shipping - discount' }, 'discount <= subtotal', { name: 'Shipping', constraint: 'shipping <= 5.0' }]
};
const lines = {
  fields: ['total'], integerDigits: 2, scale: 0, signed: true,
  lists: { lines: { maxItems: 3, fields: ['net', 'tax', 'amount'], optional: ['tax'] } },
  constraints: ['lines.amount = lines.net + lines.tax', { name: 'Sum', constraint: 'sum(lines.amount) = total' },
    'has lines.tax and abs(lines.tax) <= 5 or no lines.tax and lines.net >= 0', 'total <= 50']
};
const rates = {
  fields: ['tax', 'base', 'rate'], integerDigits: 3, scale: 0, optional: ['rate'], values: { rate: ['0', '7', '19'] },
  constraints: ['100 * tax <= rate * base', 'has rate or tax = 0', 'base <= 500']
};

test('a report names each failing constraint, and the lines that fail one on each line', () => {
  agree('invoice', invoice, { max: 10 });
  agree('lines', lines, { max: 6 });
  agree('listed rates', rates, { max: 30 });
});

test('a report finds constraints the packer moved, in either layout', () => {
  // Small budgets move the constraints' subschemas into root $defs.
  const moved = agree('lines, moved', lines, { options: { maxDepth: 12, maxSubschemas: 40 }, max: 6 });
  const nodes = [];
  (function walk(node) { if (node && typeof node === 'object') { nodes.push(node); Object.values(node).forEach(walk); } })(moved);
  const byId = new Map(nodes.filter(node => typeof node.$id === 'string').map(node => [node.$id, node]));
  assert.ok(nodes.some(node => Array.isArray(node.allOf) && node.allOf.some(entry => Object.keys(entry).join() === '$ref' && byId.get(entry.$ref)?.$comment)),
    'some constraint is a bare reference');
  agree('lines, $defs layout', lines, { options: { layout: 'defs' }, max: 6 });
  agree('invoice, $defs layout', invoice, { options: { layout: 'defs' }, max: 10 });
});

test('a report on the tally encoding names its constraints too', () => {
  const schema = agree('invoice, tally', invoice, { tally: true, max: 10 });
  const validate = prepareValidator(schema);
  const encoded = encodeTally(invoice, { subtotal: '1.0', shipping: '1.0', discount: '0.0', total: '2.0' });
  assert.deepEqual(validate.failures(encoded), { format: [], constraints: [] });
  encoded.$.d[0] = 'x';
  delete encoded.$.$.$;
  assert.deepEqual(describeFailures(validate.failures(encoded)), ['  missing: /$/$/$', '  invalid: /$/d/0']);
});

test('format problems: missing, unexpected and invalid, at JSON Pointers', () => {
  const validate = prepareValidator(compile(lines).schema);
  const report = data => describeFailures(validate.failures(data));
  assert.deepEqual(report({ lines: [{ net: '1', amount: 'x', note: 'kept' }, 3], extra: 1 }),
    ['  unexpected: /extra', '  invalid: /lines/0/amount', '  invalid: /lines/1', '  missing: /total']);
  assert.deepEqual(report({ total: '1', lines: Array(4).fill({ net: '1', amount: '1' }) }), ['  invalid: /lines']);
  assert.deepEqual(report([]), ['  invalid: the record']);
  assert.deepEqual(report({ total: '9', lines: [{ net: '1', amount: '1' }, { net: '-1', tax: '9', amount: '7' }] }),
    ['  fails Sum: sum(lines.amount) = total', '  fails: lines.amount = lines.net + lines.tax at /lines/1',
      '  fails: has lines.tax and abs(lines.tax) <= 5 or no lines.tax and lines.net >= 0 at /lines/1']);
});

test('named constraints give the same verdicts as unnamed ones', () => {
  const unnamed = { fields: ['net', 'tax', 'total'], integerDigits: 1, scale: 0, constraints: ['total = net + tax', 'tax <= net'] };
  const named = { ...unnamed, constraints: [{ name: 'BR-1', constraint: 'total = net + tax' }, 'tax <= net'] };
  for (const tally of [false, true]) {
    const prepare = spec => prepareValidator((tally ? compileTally : compile)(spec).schema);
    const encode = (spec, data) => tally ? encodeTally(spec, data) : data;
    const plain = prepare(unnamed), titled = prepare(named);
    for (let net = 0; net < 10; net++) for (let tax = 0; tax < 10; tax++) for (let total = 0; total < 10; total++) {
      const data = { net: String(net), tax: String(tax), total: String(total) };
      assert.equal(titled(encode(named, data)), plain(encode(unnamed, data)), JSON.stringify(data));
    }
  }
});

test('constraint names: syntax, refusals and where they appear', () => {
  const spec = normalizeSpec(invoice);
  assert.deepEqual(spec.constraints, invoice.constraints.map(c => c.constraint ?? c));
  assert.deepEqual(spec.names, ['Total', null, 'Shipping']);
  assert.equal(normalizeSpec({ fields: ['a'], constraints: ['a = 1'] }).names, undefined);
  assert.equal(normalizeSpec({ fields: ['a'], constraints: [{ constraint: 'a = 1' }] }).names, undefined);
  const { schema } = compile(invoice);
  assert.deepEqual(schema.$defs._.allOf.map(top => [top.title, top.$comment]),
    invoice.constraints.map(c => [c.name, c.constraint ?? c]));
  assert.deepEqual(compileTally(invoice).schema.allOf.slice(1).map(top => top.title), ['Total', undefined, 'Shipping']);
  for (const constraint of [{ name: 'x' }, { name: 'x', constraint: 'a = 1', note: 1 }, { name: '', constraint: 'a = 1' },
    { name: ' x', constraint: 'a = 1' }, { name: 'a\nb', constraint: 'a = 1' }, { name: 'x'.repeat(65), constraint: 'a = 1' }, { name: 3, constraint: 'a = 1' }, 5, null]) {
    assert.throws(() => normalizeSpec({ fields: ['a'], constraints: [constraint] }), /constraint/, JSON.stringify(constraint));
  }
});
