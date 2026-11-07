import { normalizeSpec } from './syntax.mjs';

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

/** Change one field of a record by an exact decimal amount, in integer minor units.
 * The field is a top-level name, or list[index].field for a field of one line.
 * Returns { record } with only that field changed, or { reason } when the change
 * does not apply to this contract and record.
 */
export function nudgeField(spec, record, { field, delta }) {
  let normalized;
  try { normalized = normalizeSpec(spec); } catch { return { reason: 'the contract is not valid' }; }
  const { fields, lists, integerDigits, scale, signed = false } = normalized;
  const [, list, position, member] = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(field) ?? [];
  const declared = list === undefined ? fields.includes(field) : Object.hasOwn(lists, list) && Boolean(lists[list].fields?.includes(member));
  if (!declared) return { reason: `the contract has no ${field} field` };
  if (!isObject(record)) return { reason: 'the record must be a JSON object' };
  const index = Number(position), line = list === undefined ? record : Array.isArray(record[list]) ? record[list][index] : undefined;
  if (!isObject(line)) return { reason: `the record has no line ${index + 1} in ${list}` };
  const key = member ?? field, value = toUnits(line[key], scale, signed, true);
  if (value === undefined) return { reason: `${field} must be a decimal string with ${scale} fractional digit${scale === 1 ? '' : 's'}` };
  const step = toUnits(delta, scale, true);
  if (step === undefined) return { reason: `the contract's precision cannot represent ${delta}` };
  const next = value + step, limit = 10n ** BigInt(integerDigits + scale);
  if (next < (signed ? 1n - limit : 0n)) return { reason: `${field} would fall below ${fromUnits(signed ? 1n - limit : 0n, scale)}` };
  if (next >= limit) return { reason: `${field} would exceed ${fromUnits(limit - 1n, scale)}` };
  const changed = { ...line, [key]: fromUnits(next, scale) };
  return { record: list === undefined ? changed : { ...record, [list]: record[list].map((item, i) => i === index ? changed : item) } };
}

function toUnits(text, scale, signed, exact = false) {
  if (typeof text !== 'string') return undefined;
  const match = (exact ? /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/ : /^(-?)([0-9]+)(?:\.([0-9]+))?$/).exec(text);
  if (!match || (match[1] && !signed)) return undefined;
  const [, sign, whole, fraction = ''] = match;
  // Record values need the contract's exact scale; a delta may be written shorter.
  if (exact ? fraction.length !== scale : fraction.length > scale) return undefined;
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign ? -units : units;
}

function fromUnits(units, scale) {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return (units < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
