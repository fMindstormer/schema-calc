/** Compile bounded, exact decimal equalities to JSON Schema Draft 2020-12. */
export const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_NODES = 40000;

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
}

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Expected a specification object.');
  const allowed = new Set(['fields', 'constraints', 'integerDigits', 'scale', 'title']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw new Error(`Unknown specification option: ${key}`);
  const { fields, constraints, integerDigits = 4, scale = 2, title = 'Arithmetic contract' } = spec;
  requireInteger(integerDigits, 1, 10, 'integerDigits');
  requireInteger(scale, 0, 4, 'scale');
  if (integerDigits + scale > 12) throw new Error('At most 12 decimal digits are supported.');
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 8) throw new Error('Declare between 1 and 8 fields.');
  if (fields.some(f => typeof f !== 'string' || !IDENTIFIER.test(f) || RESERVED.has(f))) throw new Error('Fields must be simple identifiers; reserved object names are disallowed.');
  if (new Set(fields).size !== fields.length) throw new Error('Field names must be unique.');
  if (!Array.isArray(constraints) || constraints.length < 1 || constraints.length > 8) throw new Error('Declare between 1 and 8 equations.');
  if (typeof title !== 'string' || title.length > 200) throw new Error('title must be a string of at most 200 characters.');
  return { fields: [...fields], constraints: [...constraints], integerDigits, scale, title };
}

/** Parse sums/differences without eval. Constants are converted exactly to minor units. */
export function parseEquation(source, spec) {
  if (typeof source !== 'string' || source.length > 500) throw new Error('An equation must be a string of at most 500 characters.');
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[+=-]|\S/g) ?? [];
  let cursor = 0, termCount = 0, constant = 0n;
  const coefficients = new Map(spec.fields.map(f => [f, 0]));
  function expression(side) {
    let sign = 1;
    if (tokens[cursor] === '+' || tokens[cursor] === '-') sign = tokens[cursor++] === '+' ? 1 : -1;
    while (true) {
      const token = tokens[cursor++];
      if (!token) throw new Error(`Missing term in equation: ${source}`);
      if (++termCount > 16) throw new Error('An equation may contain at most 16 terms.');
      if (IDENTIFIER.test(token)) {
        if (!coefficients.has(token)) throw new Error(`Unknown field: ${token}`);
        coefficients.set(token, coefficients.get(token) + side * sign);
      } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
        const [whole, fraction = ''] = token.split('.');
        if (whole.length > spec.integerDigits || fraction.length > spec.scale) throw new Error(`Constant ${token} exceeds the declared precision.`);
        constant += BigInt(side * sign) * BigInt(whole + fraction.padEnd(spec.scale, '0'));
      } else throw new Error(`Expected a field or decimal constant; found ${JSON.stringify(token)}.`);
      if (tokens[cursor] !== '+' && tokens[cursor] !== '-') return;
      sign = tokens[cursor++] === '+' ? 1 : -1;
    }
  }
  expression(1);
  if (tokens[cursor++] !== '=') throw new Error('Use one equality sign (=) between sums or differences.');
  expression(-1);
  if (cursor !== tokens.length) throw new Error(`Unexpected token: ${tokens[cursor]}`);
  return { source, terms: [...coefficients].filter(([, c]) => c !== 0), constant };
}

// (?![\s\S]) is an absolute end assertion in both ECMAScript and Python regexes.
// A bare $ also matches before a final newline in both engines.
const END = '(?![\\s\\S])';
export function amountPattern(integerDigits, scale) {
  const whole = integerDigits === 1 ? '[0-9]' : `(?:0|[1-9][0-9]{0,${integerDigits - 1}})`;
  return `^${whole}${scale ? `\\.[0-9]{${scale}}` : ''}${END}`;
}

/** Test a decimal digit, counting from the least significant minor-unit digit.
 * Missing leading digits are virtual zeroes; the root schema enforces the domain.
 */
function digitAtMostPattern(position, threshold, scale) {
  const digit = threshold === 0 ? '0' : `[0-${threshold}]`;
  if (position < scale) return `^[0-9]+\\.[0-9]{${scale - position - 1}}${digit}[0-9]{${position}}${END}`;
  const place = position - scale;
  const fraction = scale ? `\\.[0-9]{${scale}}` : '';
  const present = `[0-9]*${digit}[0-9]{${place}}${fraction}`;
  const absent = place > 0 ? `|[0-9]{1,${place}}${fraction}` : '';
  return `^(?:${present}${absent})${END}`;
}

export function compile(specification) {
  const spec = normalizeSpec(specification);
  const equations = spec.constraints.map(s => parseEquation(s, spec));
  const width = spec.integerDigits + spec.scale;
  const definitions = new Map(), interned = new Map(), predicates = new Map();
  let nextId = 0, states = 0;
  const ref = id => typeof id === 'boolean' ? id : { $ref: `#/$defs/${id}` };
  function add(id, schema) {
    if (definitions.size >= MAX_NODES) throw new Error(`Compilation exceeded the ${MAX_NODES} definition limit. Reduce precision or the number of terms.`);
    definitions.set(id, schema);
    return id;
  }
  function predicate(field, position, threshold) {
    const key = `${field}:${position}:${threshold}`;
    if (!predicates.has(key)) {
      const id = `digit_${spec.fields.indexOf(field)}_${position}_le_${threshold}`;
      add(id, { type: 'object', properties: { [field]: { type: 'string', pattern: digitAtMostPattern(position, threshold, spec.scale) } } });
      predicates.set(key, id);
    }
    return predicates.get(key);
  }
  function branch(field, position, threshold, yes, no) {
    if (yes === no) return yes;
    const test = predicate(field, position, threshold);
    const key = JSON.stringify([test, yes, no]);
    if (interned.has(key)) return interned.get(key);
    const id = add(`n${nextId++}`, { if: ref(test), then: ref(yes), else: ref(no) });
    interned.set(key, id);
    return id;
  }
  function decisionTree(field, position, children, low = 0, high = 9) {
    if (low === high) return children[low];
    const middle = Math.floor((low + high) / 2);
    return branch(field, position, middle,
      decisionTree(field, position, children, low, middle),
      decisionTree(field, position, children, middle + 1, high));
  }
  const roots = equations.map(({ source, terms, constant }) => {
    const memo = new Map();
    // The constant is a signed compile-time digit stream, never JSON arithmetic.
    const sign = constant < 0n ? -1 : 1;
    const constantDigits = (constant < 0n ? -constant : constant).toString().padStart(width, '0').split('').reverse().map(Number);
    function build(position, operand, balance) {
      if (position === width) {
        const remaining = constant / (10n ** BigInt(width));
        return BigInt(balance) + remaining === 0n;
      }
      const key = `${position}:${operand}:${balance}`;
      if (memo.has(key)) return memo.get(key);
      states++;
      let result;
      if (operand === terms.length) {
        const sum = balance + sign * (constantDigits[position] ?? 0);
        result = sum % 10 === 0 ? build(position + 1, 0, sum / 10) : false;
      } else {
        const [field, coefficient] = terms[operand];
        const children = Array.from({ length: 10 }, (_, value) => build(position, operand + 1, balance + coefficient * value));
        result = decisionTree(field, position, children);
      }
      memo.set(key, result);
      return result;
    }
    return { $comment: source, allOf: [ref(build(0, 0, 0))] };
  });
  // Some nodes become unreachable when equal branches collapse. Emit only live definitions.
  const live = new Set();
  function visit(schema) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.$ref) {
      const id = schema.$ref.slice('#/$defs/'.length);
      if (!live.has(id)) { live.add(id); visit(definitions.get(id)); }
    }
    for (const [key, value] of Object.entries(schema)) if (key !== '$ref') {
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  }
  roots.forEach(visit);
  const schema = {
    $schema: DRAFT,
    title: spec.title,
    description: 'Exact bounded decimal arithmetic, compiled to standard JSON Schema. Values are nonnegative canonical decimal strings.',
    $comment: `Generated by schema-calc. integerDigits=${spec.integerDigits}; scale=${spec.scale}.`,
    type: 'object',
    required: spec.fields,
    additionalProperties: false,
    properties: Object.fromEntries(spec.fields.map(field => [field, { type: 'string', pattern: amountPattern(spec.integerDigits, spec.scale) }])),
    allOf: roots,
    $defs: Object.fromEntries([...definitions].filter(([id]) => live.has(id)))
  };
  return {
    schema,
    stats: {
      bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
      definitions: live.size,
      decisionNodes: [...live].filter(id => id.startsWith('n')).length,
      predicates: [...live].filter(id => id.startsWith('digit_')).length,
      exploredStates: states,
      maxDigitTests: equations.reduce((n, e) => n + width * e.terms.length * 4, 0)
    }
  };
}
