/** Parse and normalize the bounded decimal equality language. */
export const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
// Words of the constraint language cannot name a field, a list or a line's field.
const KEYWORDS = new Set(['and', 'or', 'has', 'no']);
function checkKeyword(name) {
  if (KEYWORDS.has(name)) throw new Error(`and, or, has and no are words of the constraint language; rename ${name}.`);
}

function requireInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
}

export const MAX_FIELDS = 16, MAX_LISTS = 4, MAX_ITEMS = 20, MAX_ITEM_FIELDS = 4, MAX_VALUES = 32;

// optional lists fields that may be absent, and then count as zero.
function normalizeOptional(optional, fields, label) {
  if (!Array.isArray(optional) || optional.some(f => !fields.includes(f)) || new Set(optional).size !== optional.length) {
    throw new Error(`optional${label} must list declared fields, each once.`);
  }
  return [...optional];
}

/** An amount in minor units, written as the format requires: no leading zeros, exactly
 * scale fractional digits, and a minus sign only before a nonzero amount. */
export function formatAmount(units, scale) {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale), fraction = digits.slice(digits.length - scale);
  return `${units < 0n ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`;
}

// values gives a field the values it may take, so that it may multiply another field.
function normalizeValues(values, fields, label, { integerDigits, scale, signed }) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`values${label} must map fields to the values each may take.`);
  const result = {};
  for (const [field, list] of Object.entries(values)) {
    if (!fields.includes(field)) throw new Error(`values${label} names an unknown field: ${field}`);
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_VALUES) throw new Error(`List between 1 and ${MAX_VALUES} values for ${field}.`);
    const units = list.map(value => {
      const text = typeof value === 'number' ? String(value) : value;
      const match = typeof text === 'string' && /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
      if (!match) throw new Error(`The values of ${field} must be decimals; found ${JSON.stringify(value)}.`);
      const [, minus, whole, fraction = ''] = match;
      if (fraction.length > scale || BigInt(whole) >= 10n ** BigInt(integerDigits)) throw new Error(`The value ${text} of ${field} exceeds the declared precision.`);
      if (minus && !signed) throw new Error(`The value ${text} of ${field} is negative; declare "signed": true.`);
      return (minus ? -1n : 1n) * BigInt(whole + fraction.padEnd(scale, '0'));
    });
    if (new Set(units).size !== units.length) throw new Error(`The values of ${field} must differ.`);
    result[field] = units.map(u => formatAmount(u, scale));
  }
  return result;
}

// A constraint is its source text, or {"name": "BR-CO-13", "constraint": "..."}: a
// name for the reports of a failing record, kept beside the source in the schema.
function normalizeConstraint(entry) {
  if (typeof entry === 'string') return { source: entry };
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['name', 'constraint'].includes(key)) ||
      typeof entry.constraint !== 'string') throw new Error('A constraint is a string, or {"name": ..., "constraint": ...}.');
  if (entry.name === undefined) return { source: entry.constraint };
  if (typeof entry.name !== 'string' || !/^[^\u0000-\u001f\u007f]{1,64}$/.test(entry.name) || entry.name.trim() !== entry.name) {
    throw new Error('A constraint\'s name is 1 to 64 printable characters, without spaces at either end.');
  }
  return { source: entry.constraint, name: entry.name };
}

// A list holds amounts ("lines": 10), or objects with named amount fields
// ("lines": {"maxItems": 10, "fields": ["amount"]}) and any other properties.
function normalizeList(name, value, precision) {
  if (typeof value === 'number') {
    requireInteger(value, 1, MAX_ITEMS, `The maximum length of ${name}`);
    return { maxItems: value, fields: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a maximum length, or {"maxItems": n, "fields": [...]} for a list of objects.`);
  }
  for (const key of Object.keys(value)) if (!['maxItems', 'fields', 'optional', 'values'].includes(key)) throw new Error(`Unknown option for ${name}: ${key}`);
  requireInteger(value.maxItems, 1, MAX_ITEMS, `The maximum length of ${name}`);
  const { fields } = value;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_ITEM_FIELDS) {
    throw new Error(`Give the items of ${name} between 1 and ${MAX_ITEM_FIELDS} amount fields.`);
  }
  if (fields.some(f => typeof f !== 'string' || !IDENTIFIER.test(f) || RESERVED.has(f)) || new Set(fields).size !== fields.length) {
    throw new Error(`The fields of ${name} must be unique simple identifiers.`);
  }
  fields.forEach(checkKeyword);
  const optional = normalizeOptional(value.optional ?? [], fields, ` of ${name}`);
  const values = value.values === undefined ? {} : normalizeValues(value.values, fields, ` of ${name}`, precision);
  return { maxItems: value.maxItems, fields: [...fields], ...(optional.length && { optional }), ...(Object.keys(values).length && { values }) };
}

export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Expected a specification object.');
  const allowed = new Set(['fields', 'lists', 'constraints', 'names', 'integerDigits', 'scale', 'signed', 'optional', 'values', 'title']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw new Error(`Unknown specification option: ${key}`);
  const { fields, lists = {}, constraints, integerDigits = 4, scale = 2, signed = false, optional = [], values = {}, title = 'Arithmetic contract' } = spec;
  requireInteger(integerDigits, 1, 10, 'integerDigits');
  requireInteger(scale, 0, 4, 'scale');
  if (integerDigits + scale > 12) throw new Error('At most 12 decimal digits are supported.');
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)) throw new Error('lists must map each list name to its maximum length.');
  const listNames = Object.keys(lists);
  if (listNames.length > MAX_LISTS) throw new Error(`Declare at most ${MAX_LISTS} lists.`);
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS || fields.length + listNames.length < 1) throw new Error(`Declare at most ${MAX_FIELDS} fields, and at least one field or list.`);
  const names = [...fields, ...listNames];
  if (names.some(f => typeof f !== 'string' || !IDENTIFIER.test(f) || RESERVED.has(f))) throw new Error('Fields and lists must be simple identifiers; reserved object names are disallowed.');
  if (new Set(names).size !== names.length) throw new Error('Field and list names must be unique.');
  names.forEach(checkKeyword);
  if (!Array.isArray(constraints) || constraints.length < 1 || constraints.length > 8) throw new Error('Declare between 1 and 8 equations.');
  // A normalized specification gives the names apart, as names, one for each constraint.
  if (spec.names !== undefined && (!Array.isArray(spec.names) || spec.names.length !== constraints.length)) throw new Error('names must give one name, or null, for each constraint.');
  const entries = constraints.map((entry, i) => normalizeConstraint(spec.names?.[i] == null || typeof entry !== 'string' ? entry : { name: spec.names[i], constraint: entry }));
  if (typeof title !== 'string' || title.length > 200) throw new Error('title must be a string of at most 200 characters.');
  if (typeof signed !== 'boolean') throw new Error('signed must be true or false.');
  // An optional field may be absent, and then counts as zero.
  normalizeOptional(optional, fields, '');
  const precision = { integerDigits, scale, signed }, listed = normalizeValues(values, fields, '', precision);
  return { fields: [...fields], lists: Object.fromEntries(listNames.map(name => [name, normalizeList(name, lists[name], precision)])), constraints: entries.map(({ source }) => source), integerDigits, scale,
    ...(entries.some(({ name }) => name) && { names: entries.map(({ name }) => name ?? null) }), ...(signed && { signed }), ...(optional.length && { optional: [...optional] }), ...(Object.keys(listed).length && { values: listed }), title };
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
 * adds one unit (S < 0 exactly when S + 1 <= 0). A constraint written with list.field
 * holds on every line of that list: the result names the list as each, and its terms
 * name the line's own fields. A term [field, c, true] reads abs(field).
 *
 * A field with listed values may multiply another field: rate * abs(base). Such a
 * relation names the multiplier as by, and each product [field, k, absolute?] as a
 * term whose coefficient is k times the multiplier's value in minor units. Products
 * have a finer grain than the other terms, so these relations count in minor units
 * squared: every coefficient and the constant are scaled by 10^scale, and only then
 * does a strict comparison add one.
 */
export function parseConstraint(source, spec) {
  if (typeof source !== 'string' || source.length > 500) throw new Error('An equation must be a string of at most 500 characters.');
  const NAME = '[A-Za-z_][A-Za-z0-9_]*(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*)?';
  const tokens = (source.match(new RegExp(`(?:sum|abs)\\s*\\(\\s*${NAME}\\s*\\)|${NAME}|[0-9]+(?:\\.[0-9]+)?|<=|>=|[<>=+*-]|\\S`, 'g')) ?? [])
    .map(token => /^[A-Za-z_]/.test(token) ? token.replace(/\s+/g, '') : token);
  let cursor = 0, termCount = 0, constant = 0n, by;
  // Each field of a line, written list.field, is a variable of a constraint on every line.
  const members = Object.entries(spec.lists).flatMap(([list, { fields }]) => (fields ?? []).map(f => `${list}.${f}`));
  const coefficients = new Map([...variables(spec), ...members].map(name => [name, 0])), products = new Map();
  // A field, or sum(list) or sum(list.field): every position of the list, each a variable of its own.
  const SUM = /^sum\(([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\)$/;
  const MEMBER = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;
  const ABS = /^abs\((.+)\)$/;
  const operand = token => IDENTIFIER.test(token) || SUM.test(token) || MEMBER.test(token) || ABS.test(token);
  // A field of the record or of a line that lists its values.
  const listed = token => {
    const member = MEMBER.exec(token);
    if (member) return Boolean(spec.lists[member[1]]?.values?.[member[2]]);
    return IDENTIFIER.test(token) && Boolean(spec.values?.[token]);
  };
  const summed = list => spec.lists[list].fields ? `sum(${list}.${spec.lists[list].fields[0]})` : `sum(${list})`;
  // Every operand reads the record itself, or one line of a list; a constraint reads only one of them.
  const scopes = new Map();
  function list(name, field) {
    if (!Object.hasOwn(spec.lists, name)) throw new Error(`Unknown list: ${name}`);
    const { fields } = spec.lists[name];
    if (Boolean(fields) !== (field !== undefined)) throw new Error(`${name} holds ${fields ? 'objects' : 'amounts'}; write ${summed(name)}.`);
    if (fields && !fields.includes(field)) throw new Error(`Unknown field of ${name}: ${field}`);
    return spec.lists[name];
  }
  function read(token) {
    const absolute = ABS.exec(token);
    if (absolute) {
      // The tokenizer admits abs() only around a field or a line's field.
      const key = `abs(${read(absolute[1])[0]})`;
      if (!coefficients.has(key)) coefficients.set(key, 0);
      return [key];
    }
    const member = MEMBER.exec(token);
    if (member) {
      const [, name, field] = member;
      list(name, field);
      if (!scopes.has(name)) scopes.set(name, token);
      return [token];
    }
    const match = SUM.exec(token);
    if (!scopes.has('')) scopes.set('', token);
    if (!match) {
      if (Object.hasOwn(spec.lists, token)) throw new Error(`${token} is a list; write ${summed(token)}.`);
      if (!spec.fields.includes(token)) throw new Error(`Unknown field: ${token}`);
      return [token];
    }
    const [, name, field] = match;
    const { maxItems } = list(name, field);
    return Array.from({ length: maxItems }, (_, index) => field === undefined ? `${name}[${index}]` : `${name}[${index}].${field}`);
  }
  function expression(side) {
    let sign = 1;
    if (tokens[cursor] === '+' || tokens[cursor] === '-') sign = tokens[cursor++] === '+' ? 1 : -1;
    while (true) {
      let token = tokens[cursor++], factor = 1, multiplier;
      if (!token) throw new Error(`Missing term in equation: ${source}`);
      if (token === 'abs' && tokens[cursor] === '(') throw new Error("abs takes one field or one line's field: write abs(x) or abs(lines.x).");
      if (++termCount > 16) throw new Error('An equation may contain at most 16 terms.');
      if (tokens[cursor] === '*') {
        // A term is a field times a whole number, in either order, or a field times a
        // field with listed values.
        const other = tokens[cursor + 1];
        cursor += 2;
        if (!other) throw new Error(`Missing term in equation: ${source}`);
        if (operand(token) && operand(other)) {
          if (listed(token) === listed(other)) {
            throw new Error(listed(token) ? `Two fields with listed values cannot be multiplied together: ${token} * ${other}.`
              : `Fields cannot be multiplied together: ${token} * ${other}. One of them may list its values.`);
          }
          [multiplier, token] = listed(token) ? [token, other] : [other, token];
          if (SUM.test(token)) throw new Error(`${multiplier} multiplies one field, not a sum; found ${multiplier} * ${token}.`);
          if (by !== undefined && by !== multiplier) throw new Error(`A relation may multiply by one field with listed values; found ${by} and ${multiplier}.`);
          by = multiplier;
          read(multiplier);
        } else if (operand(token)) factor = coefficient(other);
        else [factor, token] = [coefficient(token), other];
        if (!operand(token)) throw new Error(`Multiply a field by a whole number; found ${factor} * ${token}.`);
        if (tokens[cursor] === '*') throw new Error('A term may have at most one coefficient.');
      }
      if (multiplier) {
        const [name] = read(token);
        products.set(name, (products.get(name) ?? 0) + side * sign);
      } else if (operand(token)) {
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
  const lines = [...scopes.keys()].filter(Boolean);
  if (lines.length > 1) throw new Error(`A constraint on each line reads one list; found ${lines.join(' and ')}.`);
  const [each] = lines;
  if (each && scopes.has('')) {
    throw new Error(`A constraint on each line of ${each} reads only that line's fields and constants; found ${scopes.get('')}. To add up the list, write sum(${scopes.get(each)}).`);
  }
  const sign = relation.startsWith('>') ? -1 : 1, strict = relation === '<' || relation === '>' ? 1n : 0n;
  // A constraint on each line names the line's own fields.
  const local = name => each ? name.slice(each.length + 1) : name;
  const term = ([key, c]) => {
    const absolute = ABS.exec(key);
    return absolute ? [local(absolute[1]), c, true] : [local(key), c];
  };
  const live = [...coefficients].filter(([, c]) => c !== 0), scaled = products.size ? 10 ** spec.scale : 1;
  return {
    source, relation: relation === '=' ? '=' : '<=',
    terms: live.map(([key, c]) => term([key, sign * c * scaled])),
    constant: BigInt(sign) * constant * BigInt(scaled) + strict,
    ...(products.size && { by: local(by), products: [...products].filter(([, k]) => k !== 0).map(([key, k]) => term([key, sign * k])) }),
    ...(each && { each })
  };
}

/** A relation that multiplies by a field with listed values, at one of those values,
 * given in minor units: an ordinary relation. */
export function instantiate({ by, products, terms, ...relation }, units) {
  const merged = new Map(terms.map(([field, c, absolute]) => [`${absolute ? 'abs ' : ''}${field}`, [field, c, absolute]]));
  for (const [field, k, absolute] of products) {
    const key = `${absolute ? 'abs ' : ''}${field}`, [, c = 0] = merged.get(key) ?? [];
    merged.set(key, [field, c + k * Number(units), absolute]);
  }
  return { ...relation, terms: [...merged.values()].filter(([, c]) => c !== 0).map(([field, c, absolute]) => absolute ? [field, c, true] : [field, c]) };
}

export const MAX_ATOMS = 8;

/** A constraint is one relation, or relations and presence tests joined by and and
 * or. and binds first: a or b and c means a, or both b and c. has x holds when the
 * optional field x is present, or when the list x has an item; no x when it does not.
 * A relation still counts an absent optional field as zero. Returns the clauses of
 * the disjunction, each a list of atoms: a parsed relation, or { has } or { no }.
 * A constraint on each line of a list joins relations on that line and tests of the
 * line's optional fields, written has list.field; its atoms name the line's fields.
 */
export function parseRule(source, spec) {
  if (typeof source !== 'string' || source.length > 500) throw new Error('An equation must be a string of at most 500 characters.');
  const parts = source.split(/\bor\b/).map(clause => clause.split(/\band\b/));
  if (parts.length === 1 && parts[0].length === 1 && !/\b(?:has|no)\b/.test(source)) {
    const relation = parseConstraint(source, spec);
    return { source, clauses: [[relation]], ...(relation.each && { each: relation.each }) };
  }
  if (parts.flat().length > MAX_ATOMS) throw new Error(`A constraint may join at most ${MAX_ATOMS} relations and tests.`);
  // Every atom reads the record, or the same list's lines.
  const scopes = new Map();
  const scope = (list, text) => { if (!scopes.has(list)) scopes.set(list, text.trim()); };
  const clauses = parts.map(clause => clause.map(text => {
    if (!text.trim()) throw new Error(`Write a relation or a test on each side of and and or: ${source}`);
    const test = /^\s*(has|no)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?\s*$/.exec(text);
    if (!test) {
      if (/\b(?:has|no)\b/.test(text)) throw new Error(`Write has or no before one optional field or list; found ${text.trim()}.`);
      const relation = parseConstraint(text.trim(), spec);
      scope(relation.each ?? '', text);
      return relation;
    }
    const [, word, name, member] = test;
    if (member !== undefined) {
      const { fields, optional = [] } = spec.lists[name] ?? {};
      if (!fields) throw new Error(Object.hasOwn(spec.lists, name) ? `${name} holds amounts; has and no test the whole list: write ${word} ${name}.` : `Unknown list: ${name}`);
      if (!fields.includes(member)) throw new Error(`Unknown field of ${name}: ${member}`);
      if (!optional.includes(member)) throw new Error(`${name}.${member} is always present; has and no test an optional field or a list.`);
      scope(name, text);
      return { [word]: member };
    }
    if (!Object.hasOwn(spec.lists, name) && !(spec.optional ?? []).includes(name)) {
      throw new Error(spec.fields.includes(name) ? `${name} is always present; has and no test an optional field or a list.` : `Unknown field: ${name}`);
    }
    scope('', text);
    return { [word]: name };
  }));
  const each = [...scopes.keys()].filter(Boolean);
  if (each.length > 1) throw new Error(`A constraint on each line reads one list; found ${each.join(' and ')}.`);
  if (each.length && scopes.has('')) {
    throw new Error(`A constraint on each line of ${each[0]} joins only relations and tests on that line; found ${scopes.get('')}.`);
  }
  return { source, clauses, ...(each.length && { each: each[0] }) };
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
export function amountPattern(integerDigits, scale, end = END, signed = false) {
  const whole = integerDigits === 1 ? '[0-9]' : `(?:0|[1-9][0-9]{0,${integerDigits - 1}})`;
  return `^${signed ? '-?' : ''}${whole}${scale ? `\\.[0-9]{${scale}}` : ''}${end}`;
}

/** The same format as schema keywords that every common regex dialect reads alike.
 * Go's RE2 has no lookahead. Python, Java and .NET let $ match before a final line
 * terminator, so a second pattern rejects any character but digits and the point,
 * and the minus sign of a signed amount.
 */
export function amountSchema(integerDigits, scale, signed = false) {
  return { type: 'string', pattern: amountPattern(integerDigits, scale, '$', signed), not: { pattern: signed ? '[^-.0-9]' : '[^.0-9]' } };
}

