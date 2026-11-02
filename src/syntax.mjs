/** Parse and normalize the bounded decimal equality language. */
export const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
}

export const MAX_LISTS = 2, MAX_ITEMS = 20, MAX_ITEM_FIELDS = 4;

// A list holds amounts ("lines": 10), or objects with named amount fields
// ("lines": {"maxItems": 10, "fields": ["amount"]}) and any other properties.
function normalizeList(name, value) {
  if (typeof value === 'number') {
    requireInteger(value, 1, MAX_ITEMS, `The maximum length of ${name}`);
    return { maxItems: value, fields: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a maximum length, or {"maxItems": n, "fields": [...]} for a list of objects.`);
  }
  for (const key of Object.keys(value)) if (key !== 'maxItems' && key !== 'fields') throw new Error(`Unknown option for ${name}: ${key}`);
  requireInteger(value.maxItems, 1, MAX_ITEMS, `The maximum length of ${name}`);
  const { fields } = value;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_ITEM_FIELDS) {
    throw new Error(`Give the items of ${name} between 1 and ${MAX_ITEM_FIELDS} amount fields.`);
  }
  if (fields.some(f => typeof f !== 'string' || !IDENTIFIER.test(f) || RESERVED.has(f)) || new Set(fields).size !== fields.length) {
    throw new Error(`The fields of ${name} must be unique simple identifiers.`);
  }
  return { maxItems: value.maxItems, fields: [...fields] };
}

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Expected a specification object.');
  const allowed = new Set(['fields', 'lists', 'constraints', 'integerDigits', 'scale', 'title']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw new Error(`Unknown specification option: ${key}`);
  const { fields, lists = {}, constraints, integerDigits = 4, scale = 2, title = 'Arithmetic contract' } = spec;
  requireInteger(integerDigits, 1, 10, 'integerDigits');
  requireInteger(scale, 0, 4, 'scale');
  if (integerDigits + scale > 12) throw new Error('At most 12 decimal digits are supported.');
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)) throw new Error('lists must map each list name to its maximum length.');
  const listNames = Object.keys(lists);
  if (listNames.length > MAX_LISTS) throw new Error(`Declare at most ${MAX_LISTS} lists.`);
  if (!Array.isArray(fields) || fields.length > 8 || fields.length + listNames.length < 1) throw new Error('Declare at most 8 fields, and at least one field or list.');
  const names = [...fields, ...listNames];
  if (names.some(f => typeof f !== 'string' || !IDENTIFIER.test(f) || RESERVED.has(f))) throw new Error('Fields and lists must be simple identifiers; reserved object names are disallowed.');
  if (new Set(names).size !== names.length) throw new Error('Field and list names must be unique.');
  if (!Array.isArray(constraints) || constraints.length < 1 || constraints.length > 8) throw new Error('Declare between 1 and 8 equations.');
  if (typeof title !== 'string' || title.length > 200) throw new Error('title must be a string of at most 200 characters.');
  return { fields: [...fields], lists: Object.fromEntries(listNames.map(name => [name, normalizeList(name, lists[name])])), constraints: [...constraints], integerDigits, scale, title };
}

/** The variables a constraint can read: each field, then each list position, as
 * list[index], or list[index].field for a list of objects.
 */
export function variables(spec) {
  return [...spec.fields, ...Object.entries(spec.lists).flatMap(([name, { maxItems, fields }]) =>
    Array.from({ length: maxItems }, (_, index) => fields ? fields.map(f => `${name}[${index}].${f}`) : [`${name}[${index}]`]).flat())];
}

export const MAX_COEFFICIENT = 1000;
function coefficient(token) {
  if (!/^[1-9][0-9]*$/.test(token) || Number(token) > MAX_COEFFICIENT) {
    throw new Error(`A coefficient must be a whole number from 1 to ${MAX_COEFFICIENT}; found ${token}.`);
  }
  return Number(token);
}

const RELATIONS = new Set(['=', '<=', '>=', '<', '>']);

/** Parse a relation between sums/differences of fields, each optionally multiplied
 * by a whole number, without eval. Constants are converted exactly to minor units.
 * The result means Σ terms + constant = 0, or <= 0 for any inequality: >= and >
 * negate both sides, and since values are whole minor units, a strict comparison
 * adds one unit (S < 0 exactly when S + 1 <= 0).
 */
export function parseConstraint(source, spec) {
  if (typeof source !== 'string' || source.length > 500) throw new Error('An equation must be a string of at most 500 characters.');
  const tokens = (source.match(/sum\s*\(\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)?\s*\)|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|<=|>=|[<>=+*-]|\S/g) ?? [])
    .map(token => token.startsWith('sum') ? token.replace(/\s+/g, '') : token);
  let cursor = 0, termCount = 0, constant = 0n;
  const coefficients = new Map(variables(spec).map(name => [name, 0]));
  // A field, or sum(list) or sum(list.field): every position of the list, each a variable of its own.
  const SUM = /^sum\(([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\)$/;
  const operand = token => IDENTIFIER.test(token) || SUM.test(token);
  const summed = list => spec.lists[list].fields ? `sum(${list}.${spec.lists[list].fields[0]})` : `sum(${list})`;
  function read(token) {
    const match = SUM.exec(token);
    if (!match) {
      if (Object.hasOwn(spec.lists, token)) throw new Error(`${token} is a list; write ${summed(token)}.`);
      if (!spec.fields.includes(token)) throw new Error(`Unknown field: ${token}`);
      return [token];
    }
    const [, list, field] = match;
    if (!Object.hasOwn(spec.lists, list)) throw new Error(`Unknown list: ${list}`);
    const { maxItems, fields } = spec.lists[list];
    if (Boolean(fields) !== (field !== undefined)) throw new Error(`${list} holds ${fields ? 'objects' : 'amounts'}; write ${summed(list)}.`);
    if (fields && !fields.includes(field)) throw new Error(`Unknown field of ${list}: ${field}`);
    return Array.from({ length: maxItems }, (_, index) => field === undefined ? `${list}[${index}]` : `${list}[${index}].${field}`);
  }
  function expression(side) {
    let sign = 1;
    if (tokens[cursor] === '+' || tokens[cursor] === '-') sign = tokens[cursor++] === '+' ? 1 : -1;
    while (true) {
      let token = tokens[cursor++], factor = 1;
      if (!token) throw new Error(`Missing term in equation: ${source}`);
      if (++termCount > 16) throw new Error('An equation may contain at most 16 terms.');
      if (tokens[cursor] === '*') {
        // A term is a field times a whole number, in either order.
        const other = tokens[cursor + 1];
        cursor += 2;
        if (!other) throw new Error(`Missing term in equation: ${source}`);
        if (operand(token) && operand(other)) throw new Error(`Fields cannot be multiplied together: ${token} * ${other}.`);
        if (operand(token)) factor = coefficient(other);
        else [factor, token] = [coefficient(token), other];
        if (!operand(token)) throw new Error(`Multiply a field by a whole number; found ${factor} * ${token}.`);
        if (tokens[cursor] === '*') throw new Error('A term may have at most one coefficient.');
      }
      if (operand(token)) {
        for (const name of read(token)) coefficients.set(name, coefficients.get(name) + side * sign * factor);
      } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
        if (operand(tokens[cursor] ?? '')) throw new Error(`Write ${token} * ${tokens[cursor]} to multiply a field.`);
        const [whole, fraction = ''] = token.split('.');
        if (whole.length > spec.integerDigits || fraction.length > spec.scale) throw new Error(`Constant ${token} exceeds the declared precision.`);
        constant += BigInt(side * sign) * BigInt(whole + fraction.padEnd(spec.scale, '0'));
      } else throw new Error(`Expected a field or decimal constant; found ${JSON.stringify(token)}.`);
      if (tokens[cursor] !== '+' && tokens[cursor] !== '-') return;
      sign = tokens[cursor++] === '+' ? 1 : -1;
    }
  }
  expression(1);
  const relation = tokens[cursor++];
  if (!RELATIONS.has(relation)) throw new Error('Use one relation (=, <=, >=, < or >) between sums or differences.');
  expression(-1);
  if (cursor !== tokens.length) throw new Error(`Unexpected token: ${tokens[cursor]}`);
  const sign = relation.startsWith('>') ? -1 : 1;
  return {
    source, relation: relation === '=' ? '=' : '<=',
    terms: [...coefficients].filter(([, c]) => c !== 0).map(([field, c]) => [field, sign * c]),
    constant: BigInt(sign) * constant + (relation === '<' || relation === '>' ? 1n : 0n)
  };
}

/** Equations only. The frozen benchmark compilers read every result as an equality. */
export function parseEquation(source, spec) {
  const parsed = parseConstraint(source, spec);
  if (parsed.relation !== '=') throw new Error('Use one equality sign (=) between sums or differences.');
  return parsed;
}

// (?![\s\S]) is an absolute end assertion in both ECMAScript and Python regexes;
// Python's bare $ also matches before a final newline. Schemas use amountSchema.
const END = '(?![\\s\\S])';
export function amountPattern(integerDigits, scale, end = END) {
  const whole = integerDigits === 1 ? '[0-9]' : `(?:0|[1-9][0-9]{0,${integerDigits - 1}})`;
  return `^${whole}${scale ? `\\.[0-9]{${scale}}` : ''}${end}`;
}

/** The same format as schema keywords that every common regex dialect reads alike.
 * Go's RE2 has no lookahead. Python, Java and .NET let $ match before a final line
 * terminator, so a second pattern rejects any character but digits and the point.
 */
export function amountSchema(integerDigits, scale) {
  return { type: 'string', pattern: amountPattern(integerDigits, scale, '$'), not: { pattern: '[^.0-9]' } };
}

