import { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../src/syntax.mjs';

const RADICES = [2, 5];
const ALL_DIGITS = (1 << 10) - 1;
const MAX_DEFINITIONS = 40000;

// Root format checks exclude final newlines, so digit predicates may use a short $ anchor.
const END = '$';
function digitClass(mask) {
  const digits = Array.from({ length: 10 }, (_, n) => n).filter(n => mask & (1 << n));
  if (digits.length === 1) return String(digits[0]);
  let text = '';
  for (let i = 0; i < digits.length; i++) {
    let j = i;
    while (j + 1 < digits.length && digits[j + 1] === digits[j] + 1) j++;
    text += j - i >= 2 ? `${digits[i]}-${digits[j]}` : digits.slice(i, j + 1).join('');
    i = j;
  }
  return `[${text}]`;
}
function pattern(position, mask, scale) {
  const digit = digitClass(mask);
  const repeat = n => n === 0 ? '' : n === 1 ? '[0-9]' : `[0-9]{${n}}`;
  if (position < scale) return `${digit}${repeat(position)}${END}`;
  const place = position - scale;
  const fraction = scale ? `\\.${repeat(scale)}` : '';
  const present = `${digit}${repeat(place)}${fraction}`;
  const absent = place > 0 && (mask & 1) ? `|^[0-9]{1,${place}}${fraction}` : '';
  return absent ? `(?:${present}${absent})${END}` : `${present}${END}`;
}
export function compile(input) {
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  const equations = spec.constraints.map(source => parseEquation(source, spec));
  const definitions = new Map(), predicates = new Map(), interned = new Map();
  let count = 0, states = 0;
  const ref = id => typeof id === 'boolean' ? id : { $ref: `#/$defs/${id}` };
  function add(schema) {
    if (definitions.size >= MAX_DEFINITIONS) throw new Error(`Compilation exceeded the ${MAX_DEFINITIONS} definition limit.`);
    // Alphabetic IDs preserve insertion order in JSON objects. Dependencies are
    // inserted before their parents, allowing bottom-up validator preparation.
    let n = count++, key = '';
    do {
      key = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 52] + key;
      n = Math.floor(n / 52) - 1;
    } while (n >= 0);
    definitions.set(key, schema);
    return key;
  }
  const strings = new Map();
  function predicate(field, position, mask) {
    const key = `${field}:${position}:${mask}`;
    if (!predicates.has(key)) {
      const stringKey = `${position}:${mask}`;
      // Share the string-level digit test even when it is applied to different fields.
      if (!strings.has(stringKey)) {
        strings.set(stringKey, add({ type: 'string', pattern: pattern(position, mask, spec.scale) }));
      }
      predicates.set(key, add({ type: 'object', properties: { [field]: ref(strings.get(stringKey)) } }));
    }
    return predicates.get(key);
  }
  function branch(field, position, mask, yes, no) {
    if (yes === no) return yes;
    // A digit set and its complement describe the same decision with swapped branches.
    if (mask > (ALL_DIGITS ^ mask)) {
      mask ^= ALL_DIGITS;
      [yes, no] = [no, yes];
    }
    const test = predicate(field, position, mask);
    if (yes === true && no === false) return test;
    let node;
    if (yes === false && no === true) node = { not: ref(test) };
    else if (no === false) node = { allOf: [ref(test), ref(yes)] };
    else if (yes === false) node = { allOf: [{ not: ref(test) }, ref(no)] };
    else if (no === true) node = { if: ref(test), then: ref(yes) };
    else if (yes === true) node = { if: ref(test), else: ref(no) };
    else node = { if: ref(test), then: ref(yes), else: ref(no) };
    const key = JSON.stringify(node);
    if (!interned.has(key)) interned.set(key, add(node));
    return interned.get(key);
  }
  function choose(field, position, values, divisor, radix) {
    const groups = new Map();
    // Several component values often have the same continuation. Test their union.
    values.forEach((child, value) => {
      if (!groups.has(child)) groups.set(child, []);
      groups.get(child).push(value);
    });
    function tree(items) {
      if (items.length === 1) return items[0][0];
      const middle = Math.ceil(items.length / 2), left = items.slice(0, middle), right = items.slice(middle);
      const selected = new Set(left.flatMap(([, digits]) => digits));
      let mask = 0;
      for (let d = 0; d < 10; d++) {
        if (selected.has(Math.floor(d / divisor) % radix)) mask |= 1 << d;
      }
      return branch(field, position, mask, tree(left), tree(right));
    }
    return tree([...groups]);
  }
  const roots = equations.map(({ source, terms, constant }) => {
    const memo = new Map();
    const digits = (constant < 0n ? -constant : constant).toString()
      .padStart(width, '0').split('').reverse()
      .map(d => Number(d) * (constant < 0n ? -1 : 1));
    function build(position, stage, operand, balance) {
      if (position === width) return BigInt(balance) + constant / (10n ** BigInt(width)) === 0n;
      if (stage === 0 && operand === 0) balance += digits[position] ?? 0;
      const key = `${position}:${stage}:${operand}:${balance}`;
      if (memo.has(key)) return memo.get(key);
      states++;
      let result;
      // d = (d mod 2) + 2 floor(d/2). Requiring divisibility by 2 and then
      // by 5 is exactly the original decimal-column divisibility test.
      const radix = RADICES[stage];
      if (operand === terms.length) {
        if (balance % radix !== 0) result = false;
        else if (stage === RADICES.length - 1) result = build(position + 1, 0, 0, balance / radix);
        else result = build(position, stage + 1, 0, balance / radix);
      } else {
        const [field, coefficient] = terms[operand];
        const children = Array.from({ length: radix }, (_, d) =>
          build(position, stage, operand + 1, balance + coefficient * d));
        const divisor = RADICES.slice(0, stage).reduce((a, b) => a * b, 1);
        result = choose(field, position, children, divisor, radix);
      }
      memo.set(key, result);
      return result;
    }
    return { $comment: source, allOf: [ref(build(0, 0, 0, 0))] };
  });

  // Count incoming references once per live definition, rather than once per
  // expanded path. This is the graph's initial physical reference count.
  const live = new Set(), uses = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const key = node.$ref.slice('#/$defs/'.length);
      uses.set(key, (uses.get(key) || 0) + 1);
      if (!live.has(key)) {
        live.add(key);
        visit(definitions.get(key));
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== '$ref') {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  roots.forEach(visit);
  const inline = new Set();
  function childRefs(node, action) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) action(node.$ref.slice('#/$defs/'.length));
    for (const [key, value] of Object.entries(node)) if (key !== '$ref') {
      if (Array.isArray(value)) value.forEach(v => childRefs(v, action));
      else childRefs(value, action);
    }
  }
  // Parents first: inlining n copies replaces one definition, so each direct
  // child gains n-1 physical references. Small nodes can cost less than $refs.
  for (const [key, node] of [...definitions].reverse()) {
    if (!live.has(key)) continue;
    const n = uses.get(key), size = JSON.stringify(node).length;
    const sharedSize = size + JSON.stringify(key).length + 2 + n * JSON.stringify(ref(key)).length;
    if (n * size <= sharedSize) {
      inline.add(key);
      childRefs(node, child => uses.set(child, uses.get(child) + n - 1));
    }
  }
  function emit(node) {
    if (!node || typeof node !== 'object') return node;
    // Before emission all generated references are standalone {$ref: ...} nodes.
    if (node.$ref && inline.has(node.$ref.slice('#/$defs/'.length))) {
      return emit(definitions.get(node.$ref.slice('#/$defs/'.length)));
    }
    if (Array.isArray(node)) return node.map(emit);
    const result = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, emit(value)]));
    // These keywords conjoin independently. Never merge conditional keywords:
    // a then/else in one allOf branch cannot acquire an if from another branch.
    const mergeable = item => item && typeof item === 'object' &&
      Object.keys(item).every(k => ['type', 'properties', '$ref', 'not'].includes(k));
    if (result.allOf && result.allOf.every(mergeable)) {
      const merged = {};
      let compatible = true;
      for (const item of result.allOf) for (const [key, value] of Object.entries(item)) {
        if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) compatible = false;
        merged[key] = value;
      }
      if (compatible) {
        delete result.allOf;
        Object.assign(result, merged);
      }
    }
    return result;
  }
  const schema = {
    $schema: DRAFT,
    title: spec.title,
    type: 'object', required: spec.fields, additionalProperties: false,
    properties: Object.fromEntries(spec.fields.map(f => [f, {
      type: 'string', pattern: amountPattern(spec.integerDigits, spec.scale)
    }])),
    allOf: roots.map(emit),
    $defs: Object.fromEntries([...definitions]
      .filter(([key]) => live.has(key) && !inline.has(key))
      .map(([key, node]) => [key, emit(node)]))
  };
  const decisionIds = new Set(interned.values());
  const testsPerDigit = RADICES.reduce((n, radix) => n + Math.ceil(Math.log2(radix)), 0);
  return { schema, stats: {
    bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
    definitions: Object.keys(schema.$defs).length,
    decisionNodes: [...live].filter(id => decisionIds.has(id)).length,
    predicates: [...predicates.values()].filter(id => live.has(id)).length,
    exploredStates: states,
    maxDigitTests: equations.reduce((n, equation) => n + width * equation.terms.length * testsPerDigit, 0)
  } };
}

export { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../src/syntax.mjs';
