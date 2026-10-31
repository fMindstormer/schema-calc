import { normalizeSpec, parseConstraint, DRAFT } from './syntax.mjs';
import { encodeColumns, decodeColumns } from './decimal-columns.mjs';

const ref = id => ({ $ref: `#/$defs/${id}` });
const countIn = (tags, min, max) => ({ type: 'array', contains: tags.length === 1 ? { const: tags[0] } : { enum: tags },
  minContains: min, maxContains: max });
const exactCount = (tags, count) => countIn(tags, count, count);
const digitAt = (value, position) => Number((value < 0n ? -value : value) / (10n ** BigInt(position)) % 10n);
// A field has one tally block per unit of its largest coefficient, and the schema
// grows roughly with the cube of that count: tens of kilobytes at 16, megabytes at 100.
export const MAX_TALLY_COPIES = 16;

function layout(input) {
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  const equations = spec.constraints.map(source => parseConstraint(source, spec));
  let next = 1;
  const fields = spec.fields.map(name => {
    const copies = Math.max(1, ...equations.map(e => Math.abs(e.terms.find(([f]) => f === name)?.[1] ?? 0)));
    if (copies > MAX_TALLY_COPIES) {
      throw new Error(`The tally encoding supports coefficients up to ${MAX_TALLY_COPIES}; ${name} has ${copies}. Use the flat encoding.`);
    }
    return { name, tags: Array.from({ length: copies }, () => next++) };
  });
  const constants = equations.flatMap((equation, index) => equation.constant === 0n ? [] :
    [{ index, tag: next++, value: equation.constant }]);
  const tags = [...fields.flatMap(f => f.tags), ...constants.map(c => c.tag)];
  return { spec, width, equations, fields, constants, tags };
}

/** Compile decimal addition into standard contains-counts and a recursive carry
 * automaton. Input is a linked list of tally columns, not the original strings.
 */
export function compileTally(input) {
  const { spec, width, equations, fields, constants, tags } = layout(input);
  const defs = {};
  defs.row = { type: 'array', minItems: tags.length * 9, maxItems: tags.length * 9,
    // These tiny enums cost less to inline than a reference and avoid one schema
    // resolution per token in interpreters.
    prefixItems: tags.flatMap(tag => Array.from({ length: 9 }, () => ({ enum: [-tag, tag] }))), items: false };

  // Repeated coefficients get duplicate tally blocks. They must encode the SAME
  // digit; otherwise two equations could silently use different field values.
  const copies = fields.filter(f => f.tags.length > 1).map(field => {
    const equal = count => ({ allOf: field.tags.slice(1).map(tag => exactCount([tag], count)) });
    let check = equal(9);
    for (let count = 8; count >= 0; count--) check = { if: exactCount([field.tags[0]], count), then: equal(count), else: check };
    return check;
  });
  defs.cell = { type: 'object', required: ['d', '$'], additionalProperties: false,
    properties: { d: copies.length ? { allOf: [ref('row'), ...copies] } : ref('row'), $: true } };

  let arithmeticStates = 0, transitions = 0, maxArithmeticCounts = 0;
  const roots = equations.map((equation, index) => {
    const selected = equation.terms.flatMap(([name, coefficient]) =>
      fields.find(f => f.name === name).tags.slice(0, Math.abs(coefficient)).map(tag => Math.sign(coefficient) * tag));
    const constant = constants.find(c => c.index === index);
    if (constant) selected.push(constant.tag * (constant.value < 0n ? -1 : 1));
    if (!selected.length) return true;
    const bias = 9 * selected.filter(tag => tag < 0).length, maximum = 9 * selected.length;
    const terminal = Number(-(equation.constant / (10n ** BigInt(width)))), exact = equation.relation === '=';
    const carries = new Map();
    let maxBranches = 0;
    function carry(value) {
      if (carries.has(value)) return ref(carries.get(value));
      const id = `c${index}_${value < 0 ? `n${-value}` : value}`;
      carries.set(value, id); arithmeticStates++;
      // An equality continues only from counts that complete a multiple of ten. For
      // S <= 0 every count continues, with ceil(sum / 10) as the next carry; that grows
      // with the count, so each continuation is one contiguous range of counts.
      const ranges = [];
      for (let count = 0; count <= maximum; count++) {
        const sum = value + count - bias;
        if (exact && sum % 10 !== 0) continue;
        const next = exact ? sum / 10 : Math.ceil(sum / 10);
        if (!exact && ranges.at(-1)?.next === next) ranges.at(-1).max = count;
        else ranges.push({ min: count, max: count, next });
      }
      const middle = range => Math.abs((range.min + range.max) / 2 - maximum / 2);
      ranges.sort((a, b) => middle(a) - middle(b) || a.min - b.min);
      // Row shapes already bound the count, so an inequality's last range needs no test.
      let decision = exact ? false : { type: 'object', properties: { $: carry(ranges.pop().next) } };
      maxBranches = Math.max(maxBranches, ranges.length);
      // Only the matching count follows a tail. anyOf over recursive alternatives
      // can make interpreters traverse rejected tails repeatedly or exponentially.
      for (const { min, max, next } of ranges.toReversed()) {
        transitions++;
        decision = {
          if: { type: 'object', properties: { d: countIn(selected, min, max) } },
          then: { type: 'object', properties: { $: carry(next) } },
          else: decision
        };
      }
      defs[id] = { if: { type: 'null' }, then: exact ? value === terminal : value <= terminal, else: decision };
      return ref(id);
    }
    const root = { $comment: equation.source, ...carry(0) };
    maxArithmeticCounts += maxBranches;
    return root;
  });
  let shape = { type: 'null' };
  for (let position = width - 1; position >= 0; position--) {
    const constantChecks = constants.map(c => exactCount([c.tag], digitAt(c.value, position)));
    const id = `p${position}`;
    defs[id] = { type: 'object', allOf: [ref('cell')], properties: { $: shape,
      ...(constantChecks.length ? { d: { allOf: constantChecks } } : {}) } };
    shape = ref(id);
  }
  const schema = { $schema: DRAFT, title: `${spec.title} (tally columns)`, allOf: [shape, ...roots], $defs: defs };
  return { schema, stats: { bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
    definitions: Object.keys(defs).length, arithmeticStates, decisionNodes: transitions,
    maxCountTests: width * (maxArithmeticCounts + constants.length + fields.reduce((n, f) =>
      n + (f.tags.length > 1 ? 9 + f.tags.length - 1 : 0), 0)), tokensPerColumn: tags.length * 9 } };
}

/** Converts the supplied values, including a wrong total, without calculating any
 * equation or carry. Fixed constant blocks belong to the contract, not a witness.
 */
export function encodeTally(input, record) {
  const { spec, fields, constants } = layout(input);
  let position = 0;
  function convert(column) {
    if (column === null) return null;
    const cells = [...fields.flatMap(f => f.tags.map(tag => [tag, column[f.name]])),
      ...constants.map(c => [c.tag, digitAt(c.value, position)])];
    position++;
    return { d: cells.flatMap(([tag, digit]) => Array.from({ length: 9 }, (_, j) => j < digit ? tag : -tag)),
      $: convert(column.$) };
  }
  return convert(encodeColumns(spec, record));
}

/** Decode the representation and check its shape/copy/constant integrity only.
 * This deliberately does not check the business equations.
 */
export function decodeTally(input, encoded) {
  const { spec, width, fields, constants, tags } = layout(input);
  function convert(row, position) {
    if (position === width) {
      if (row !== null) throw new Error('Incorrect number of tally columns.');
      return null;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2 ||
        !Object.hasOwn(row, '$') || !Array.isArray(row.d) || row.d.length !== tags.length * 9) throw new Error('Invalid tally column.');
    const counts = new Map();
    tags.forEach((tag, i) => {
      const block = row.d.slice(i * 9, (i + 1) * 9);
      if (block.some(value => value !== tag && value !== -tag)) throw new Error('Invalid tally token.');
      counts.set(tag, block.filter(value => value === tag).length);
    });
    for (const f of fields) if (f.tags.some(tag => counts.get(tag) !== counts.get(f.tags[0]))) throw new Error('Inconsistent field copies.');
    for (const c of constants) if (counts.get(c.tag) !== digitAt(c.value, position)) throw new Error('Incorrect constant digit.');
    return { ...Object.fromEntries(fields.map(f => [f.name, counts.get(f.tags[0])])), $: convert(row.$, position + 1) };
  }
  return decodeColumns(spec, convert(encoded, 0));
}
