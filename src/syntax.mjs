/** Parse and normalize the bounded decimal equality language. */
export const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

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

export const MAX_COEFFICIENT = 1000;
function coefficient(token) {
  if (!/^[1-9][0-9]*$/.test(token) || Number(token) > MAX_COEFFICIENT) {
    throw new Error(`A coefficient must be a whole number from 1 to ${MAX_COEFFICIENT}; found ${token}.`);
  }
  return Number(token);
}

/** Parse sums/differences of fields, each optionally multiplied by a whole number,
 * without eval. Constants are converted exactly to minor units.
 */
export function parseEquation(source, spec) {
  if (typeof source !== 'string' || source.length > 500) throw new Error('An equation must be a string of at most 500 characters.');
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[+=*-]|\S/g) ?? [];
  let cursor = 0, termCount = 0, constant = 0n;
  const coefficients = new Map(spec.fields.map(f => [f, 0]));
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
        if (IDENTIFIER.test(token) && IDENTIFIER.test(other)) throw new Error(`Fields cannot be multiplied together: ${token} * ${other}.`);
        if (IDENTIFIER.test(token)) factor = coefficient(other);
        else [factor, token] = [coefficient(token), other];
        if (!IDENTIFIER.test(token)) throw new Error(`Multiply a field by a whole number; found ${factor} * ${token}.`);
        if (tokens[cursor] === '*') throw new Error('A term may have at most one coefficient.');
      }
      if (IDENTIFIER.test(token)) {
        if (!coefficients.has(token)) throw new Error(`Unknown field: ${token}`);
        coefficients.set(token, coefficients.get(token) + side * sign * factor);
      } else if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) {
        if (IDENTIFIER.test(tokens[cursor] ?? '')) throw new Error(`Write ${token} * ${tokens[cursor]} to multiply a field.`);
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

