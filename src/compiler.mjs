import { normalizeSpec, parseConstraint, amountSchema, DRAFT } from './syntax.mjs';
import { packResources, MAX_DEPTH, MAX_SUBSCHEMAS } from './resources.mjs';

const RADICES = [2, 5];
const ALL_DIGITS = (1 << 10) - 1;
const MAX_DEFINITIONS = 40000;

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
  // Root checks fix the decimal point and exclude line breaks. Only the target
  // digit needs a character class; the known suffix can be skipped with dots.
  const offset = position + (scale > 0 && position >= scale ? 1 : 0);
  const suffix = offset === 0 ? '' : offset === 1 ? '.' : `.{${offset}}`;
  return `${digitClass(mask)}${suffix}$`;
}

export function compile(input, { maxDepth = MAX_DEPTH, maxSubschemas = MAX_SUBSCHEMAS, maxDefinitions = MAX_DEFINITIONS, layout = 'embedded', listSums = 'counts' } = {}) {
  if (!['positions', 'counts'].includes(listSums)) throw new Error(`Unknown listSums: ${listSums}`);
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  const equations = spec.constraints.map(source => parseConstraint(source, spec));
  const definitions = new Map(), predicates = new Map(), interned = new Map();
  let count = 0, states = 0;
  const ref = id => typeof id === 'boolean' ? id : { $ref: `#/$defs/${id}` };
  function add(schema) {
    if (definitions.size >= maxDefinitions) throw new Error(`Compilation exceeded the ${maxDefinitions} definition limit.`);
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
  const strings = new Map(), optional = new Set(spec.optional);
  // Apply a string test to one variable: a field, a list position or a line's field.
  function predicate(field, stringKey, string) {
    const key = `${field}:${stringKey}`;
    if (!predicates.has(key)) {
      // Share the string-level test even when it is applied to different fields.
      if (!strings.has(stringKey)) strings.set(stringKey, add(string()));
      // A list position is reached through prefixItems. minItems makes a missing
      // item fail the nonzero-digit test, exactly as a zero would; required does the
      // same for an absent optional field.
      const [, list, index, member] = /^(.+?)\[(\d+)\](?:\.(.+))?$/.exec(field) ?? [];
      const test = ref(strings.get(stringKey));
      const item = member === undefined ? test : { type: 'object', properties: { [member]: test } };
      predicates.set(key, add({ type: 'object', ...(optional.has(field) && { required: [field] }), properties: list === undefined ? { [field]: test }
        : { [list]: { type: 'array', minItems: Number(index) + 1, prefixItems: [...Array(Number(index)).fill(true), item] } } }));
    }
    return predicates.get(key);
  }
  const digitTest = (field, position, mask) => predicate(field, `${position}:${mask}`, () => ({ type: 'string', pattern: pattern(position, mask, spec.scale) }));
  const signTest = field => predicate(field, '-', () => ({ type: 'string', pattern: '^-' }));
  function branch(field, position, mask, yes, no) {
    if (yes === no) return yes;
    // Always test a set excluding zero. An absent leading digit then fails the
    // predicate, exactly as a virtual zero should; no padding alternative is needed.
    // A minus sign is not a digit, so it reads as a leading zero too.
    if (mask & 1) {
      mask ^= ALL_DIGITS;
      [yes, no] = [no, yes];
    }
    return decide(digitTest(field, position, mask), yes, no);
  }
  function decide(test, yes, no) {
    if (yes === no) return yes;
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
  // Counting reads the digits of every line at one position through how many lines
  // have them. A list's column sum depends only on those counts: Σ p = #(odd digits)
  // for the radix-2 component, and Σ q = #(q odd) + 2#(q in 2..3) + 4#(q = 4) for
  // q = floor(d / 2). Each mask excludes 0, so a missing item or digit counts as zero.
  const COUNTED = [[[0b1010101010, 1]], [[0b0011001100, 1], [0b0011110000, 2], [0b1100000000, 4]]];
  const countTests = new Map();
  function countTest(list, member, sign, position, mask, low, high) {
    const key = JSON.stringify([list, member, sign, position, mask, low, high]);
    if (!countTests.has(key)) {
      const string = { type: 'string', pattern: pattern(position, mask, spec.scale), ...(sign > 0 && spec.signed && { not: { pattern: '^-' } }), ...(sign < 0 && { allOf: [{ pattern: '^-' }] }) };
      const item = member === undefined ? string : { type: 'object', properties: { [member]: string } };
      // required keeps the ranges disjoint when the list is absent; otherwise every range
      // would hold, and an anyOf would try each branch in turn, exponentially.
      countTests.set(key, add({ type: 'object', required: [list], properties: { [list]: { type: 'array', contains: item, minContains: low, ...(high < spec.lists[list].maxItems && { maxContains: high }) } } }));
    }
    return countTests.get(key);
  }
  // Select the continuation for the count in one step: an anyOf of disjoint count
  // ranges, each a conditional, so no validator descends into a branch that fails.
  function countSwitch(list, member, sign, position, mask, children) {
    const ranges = [];
    children.forEach((child, count) => {
      if (ranges.length && ranges.at(-1).child === child) ranges.at(-1).high = count;
      else ranges.push({ low: count, high: count, child });
    });
    const live = ranges.filter(range => range.child !== false);
    if (!live.length) return false;
    if (live.length === 1 && ranges.length === 1) return live[0].child;
    const test = ({ low, high }) => countTest(list, member, sign, position, mask, low, high);
    if (live.length === 1) return decide(test(live[0]), live[0].child, false);
    if (ranges.length === 2) return decide(test(ranges[0]), ranges[0].child, ranges[1].child);
    const node = { anyOf: live.map(range => range.child === true ? ref(test(range)) : { if: ref(test(range)), then: ref(range.child), else: false }) };
    const key = JSON.stringify(node);
    if (!interned.has(key)) interned.set(key, add(node));
    return interned.get(key);
  }
  const pathTests = [];
  const machines = equations.map(({ source, terms: allTerms, constant, relation, each }) => {
    const memo = new Map(), exact = relation === '=';
    // With listSums: 'counts', every position of a list field has the same coefficient,
    // since only sum() reads them, and the positions become one counted term.
    const listPosition = /^(.+?)\[(\d+)\](?:\.(.+))?$/;
    const counted = listSums === 'counts' ? [...new Map(allTerms.filter(([field]) => listPosition.test(field)).map(([field, coefficient]) => {
      const [, list, , member] = listPosition.exec(field);
      const positions = allTerms.filter(([other]) => { const [, l, , m] = listPosition.exec(other) ?? []; return l === list && m === member; });
      if (positions.length !== spec.lists[list].maxItems || positions.some(([, c]) => c !== coefficient)) throw new Error(`Every position of ${list} must have the same coefficient.`);
      return [`${list}.${member}`, { list, member, coefficient }];
    })).values()] : [];
    const terms = counted.length ? allTerms.filter(([field]) => !listPosition.test(field)) : allTerms;
    const steps = RADICES.map((_, stage) => [...terms.map(([field, coefficient]) => ({ field, coefficient })),
      ...counted.flatMap(({ list, member, coefficient }) => COUNTED[stage].flatMap(([mask, weight]) =>
        (spec.signed ? [1, -1] : [1]).map(sign => ({ list, member, mask, sign, coefficient: coefficient * weight }))))]);
    // At most one test per binary decision on a digit, plus its sign; a count may try every range.
    pathTests.push(width * (each ? spec.lists[each].maxItems : 1) * steps.reduce((n, stageSteps, stage) => n + stageSteps.reduce((m, step) =>
      m + (step.list ? spec.lists[step.list].maxItems + 1 : Math.ceil(Math.log2(RADICES[stage])) + (spec.signed ? 1 : 0)), 0), 0));
    const digits = (constant < 0n ? -constant : constant).toString()
      .padStart(width, '0').split('').reverse()
      .map(d => Number(d) * (constant < 0n ? -1 : 1));
    function build(position, stage, operand, balance) {
      if (position === width) {
        const final = BigInt(balance) + constant / (10n ** BigInt(width));
        return exact ? final === 0n : final <= 0n;
      }
      if (stage === 0 && operand === 0) balance += digits[position] ?? 0;
      const key = `${position}:${stage}:${operand}:${balance}`;
      if (memo.has(key)) return memo.get(key);
      states++;
      let result;
      // d = (d mod 2) + 2 floor(d/2). Requiring divisibility by 2 and then
      // by 5 is exactly the original decimal-column divisibility test.
      const radix = RADICES[stage];
      if (operand === steps[stage].length) {
        // The rest of the sum is a multiple of radix. An equality needs this stage to
        // divide exactly. For S <= 0, write balance = radix q + r with 0 <= r < radix:
        // r only matters through r > 0, so carry ceil(balance / radix).
        if (exact && balance % radix !== 0) result = false;
        else {
          const carry = exact ? balance / radix : Math.ceil(balance / radix);
          result = stage === RADICES.length - 1 ? build(position + 1, 0, 0, carry) : build(position, stage + 1, 0, carry);
        }
      } else if (steps[stage][operand].list) {
        const { list, member, mask, sign, coefficient } = steps[stage][operand];
        result = countSwitch(list, member, sign, position, mask, Array.from({ length: spec.lists[list].maxItems + 1 }, (_, count) =>
          build(position, stage, operand + 1, balance + sign * coefficient * count)));
      } else {
        const { field, coefficient } = steps[stage][operand];
        const divisor = RADICES.slice(0, stage).reduce((a, b) => a * b, 1);
        const read = sign => choose(field, position, Array.from({ length: radix }, (_, d) =>
          build(position, stage, operand + 1, balance + sign * coefficient * d)), divisor, radix);
        // A signed amount is its sign times its digits. Testing the sign wherever a digit
        // is read keeps it out of the state, at the cost of one more test per read.
        result = spec.signed ? decide(signTest(field), read(-1), read(1)) : read(1);
      }
      memo.set(key, result);
      return result;
    }
    return { $comment: source, allOf: [ref(build(0, 0, 0, 0))] };
  });
  // A constraint on each line is one machine over the line's fields, applied to every
  // item of the list, so it does not grow with the list's length.
  const roots = machines.filter((_, i) => !equations[i].each);
  const lineRoots = list => machines.filter((_, i) => equations[i].each === list);

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
  machines.forEach(visit);
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
    // The final encoding declares a shared resource at its first use, so only
    // n-1 references and one $id declaration remain. Names may shorten later.
    const sharedSize = size + key.length + 9 + (n - 1) * (key.length + 11);
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
  const amount = amountSchema(spec.integerDigits, spec.scale, spec.signed);
  const graph = {
    $schema: DRAFT,
    title: spec.title,
    type: 'object', required: [...spec.fields.filter(f => !optional.has(f)), ...Object.keys(spec.lists)], additionalProperties: false,
    properties: {
      ...Object.fromEntries(spec.fields.map(f => [f, amount])),
      // Items of a list of objects may carry other properties, such as a description.
      ...Object.fromEntries(Object.entries(spec.lists).map(([name, { maxItems, fields }]) =>
        [name, { type: 'array', maxItems, items: fields
          ? { type: 'object', required: fields, properties: Object.fromEntries(fields.map(f => [f, amount])),
            ...(lineRoots(name).length && { allOf: lineRoots(name).map(emit) }) }
          : amount }]))
    },
    ...(roots.length && { allOf: roots.map(emit) }),
    $defs: Object.fromEntries([...definitions]
      .filter(([key]) => live.has(key) && !inline.has(key))
      .map(([key, node]) => [key, emit(node)]))
  };
  const { schema, resources } = packResources(graph, { maxDepth, maxSubschemas, layout });
  const decisionIds = new Set(interned.values());
  return { schema, stats: {
    bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
    definitions: resources,
    decisionNodes: [...live].filter(id => decisionIds.has(id)).length,
    predicates: [...predicates.values()].filter(id => live.has(id)).length,
    exploredStates: states,
    maxDigitTests: pathTests.reduce((a, b) => a + b, 0)
  } };
}

export { normalizeSpec, parseEquation, parseConstraint, amountPattern, amountSchema, DRAFT } from './syntax.mjs';
