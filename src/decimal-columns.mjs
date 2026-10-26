import { normalizeSpec, amountPattern } from './syntax.mjs';
const NEXT = '$';

/** Reversible representation change only: never computes or repairs an equation. */
export function encodeColumns(input, record) {
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== spec.fields.length || spec.fields.some(f => !Object.hasOwn(record, f))) {
    throw new Error('Record must contain exactly the declared fields.');
  }
  const format = new RegExp(amountPattern(spec.integerDigits, spec.scale));
  const digits = spec.fields.map(f => {
    if (typeof record[f] !== 'string' || !format.test(record[f])) throw new Error(`Invalid decimal amount: ${f}`);
    return record[f].replace('.', '').padStart(width, '0');
  });
  let tail = null;
  for (let i = 0; i < width; i++) {
    tail = { ...Object.fromEntries(spec.fields.map((f, j) => [f, Number(digits[j][i])])), [NEXT]: tail };
  }
  return tail;
}

export function decodeColumns(input, columns) {
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  const values = Object.fromEntries(spec.fields.map(f => [f, '']));
  let row = columns;
  for (let i = 0; i < width; i++) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== spec.fields.length + 1 ||
        !Object.hasOwn(row, NEXT) || spec.fields.some(f => !Object.hasOwn(row, f) || !Number.isInteger(row[f]) || row[f] < 0 || row[f] > 9)) {
      throw new Error('Invalid decimal column.');
    }
    for (const field of spec.fields) values[field] = String(row[field]) + values[field];
    row = row[NEXT];
  }
  if (row !== null) throw new Error('Incorrect number of decimal columns.');
  return Object.fromEntries(spec.fields.map(f => {
    const text = values[f], split = width - spec.scale;
    const whole = text.slice(0, split).replace(/^0+(?=[0-9])/, '');
    return [f, whole + (spec.scale ? `.${text.slice(split)}` : '')];
  }));
}
