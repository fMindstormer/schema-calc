// Experimental only: the production compiler remains src/compiler.mjs.
// Factor the last two unit-coefficient operands into a modular equality and wrap test.
import { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../../src/syntax.mjs';
import { packResources } from '../../src/resources.mjs';

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

export function compilePair(input, { packed = true, phases = [0,1] } = {}) {
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
    // Always test a set excluding zero. An absent leading digit then fails the
    // predicate, exactly as a virtual zero should; no padding alternative is needed.
    if (mask & 1) {
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
  function intern(node) {
    const key = JSON.stringify(node);
    if (!interned.has(key)) interned.set(key, add(node));
    return interned.get(key);
  }
  function atom(field, position, mask) {
    if (!mask) return false;
    if (mask === ALL_DIGITS) return true;
    if (mask & 1) return { not: ref(predicate(field, position, mask ^ ALL_DIGITS)) };
    return ref(predicate(field, position, mask));
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
      } else if (phases.includes(stage) && operand === terms.length - 2 && Math.abs(terms[operand][1]) === 1 && Math.abs(terms[operand+1][1]) === 1) {
        // Complement negative components to x,y in [0, radix). If r = -b mod
        // radix, divisibility means x = (r-y) mod radix. Compare their binary
        // codes with standard two-branch oneOf (XOR), then select the quotient:
        // (b+x+y)/radix = (b+r)/radix + [x>r]. The equality is shared independently
        // of its carry continuation, which is followed only once.
        const [fx,cx] = terms[operand], [fy,cy] = terms[operand+1];
        const b = balance - (radix - 1) * ((cx < 0 ? 1 : 0) + (cy < 0 ? 1 : 0));
        const r = ((-b % radix) + radix) % radix, carry0 = (b + r) / radix;
        const divisor = stage === 0 ? 1 : 2;
        const value = (d,c) => c > 0 ? Math.floor(d/divisor)%radix : radix-1-Math.floor(d/divisor)%radix;
        const assertions = [];
        for (let bit = 0; bit < Math.ceil(Math.log2(radix)); bit++) {
          let mx=0,my=0;
          for(let d=0;d<10;d++) {
            if ((value(d,cx)>>bit)&1) mx |= 1<<d;
            if ((((r-value(d,cy)+radix)%radix)>>bit)&1) my |= 1<<d;
          }
          assertions.push({not:{oneOf:[atom(fx,position,mx),atom(fy,position,my)]}});
        }
        const advance = c => stage === 1 ? build(position+1,0,0,c) : build(position,stage+1,0,c);
        const no = advance(carry0);
        let mask=0; for(let d=0;d<10;d++) if(value(d,cx)>r)mask|=1<<d;
        const continuation = mask ? branch(fx,position,mask,advance(carry0+1),no) : no;
        if(continuation === false) result = false;
        else { const equality = intern({allOf:assertions}); result = continuation === true ? equality : intern({allOf:[ref(equality), ref(continuation)]}); }
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
  const graph = {
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
  const { schema, resources } = packed ? packResources(graph) : {schema: graph, resources: Object.keys(graph.$defs).length};
  const decisionIds = new Set(interned.values());
  const testsPerDigit = RADICES.reduce((n, radix) => n + Math.ceil(Math.log2(radix)), 0);
  return { schema, stats: {
    bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
    definitions: resources,
    decisionNodes: [...live].filter(id => decisionIds.has(id)).length,
    predicates: [...predicates.values()].filter(id => live.has(id)).length,
    exploredStates: states,
    maxDigitTests: equations.reduce((n, equation) => {
      const paired = equation.terms.length >= 2 && equation.terms.slice(-2).every(([, c]) => Math.abs(c) === 1);
      return n + width * (equation.terms.length * testsPerDigit + (paired ? phases.length : 0));
    }, 0)
  } };
}

export { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../../src/syntax.mjs';

/** Size-only experimental selection; not used by the production compiler. */
export function compile(input) {
  const candidates = [[], [0], [1], [0,1]].map(phases => ({...compilePair(input, {phases}), phases}));
  candidates.sort((a,b) => a.stats.bytes - b.stats.bytes);
  return candidates[0];
}
