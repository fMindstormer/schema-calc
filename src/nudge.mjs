import { normalizeSpec } from './syntax.mjs';

/** Change one field of a record by an exact decimal amount, in integer minor units.
 * Returns { record } with only that field changed, or { reason } when the change
 * does not apply to this contract and record.
 */
export function nudgeField(spec, record, { field, delta }) {
  let normalized;
  try { normalized = normalizeSpec(spec); } catch { return { reason: 'the contract is not valid' }; }
  const { fields, integerDigits, scale } = normalized;
  if (!fields.includes(field)) return { reason: `the contract has no ${field} field` };
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { reason: 'the record must be a JSON object' };
  const value = toUnits(record[field], scale, false);
  if (value === undefined) return { reason: `${field} must be a decimal string with ${scale} fractional digit${scale === 1 ? '' : 's'}` };
  const step = toUnits(delta, scale, true);
  if (step === undefined) return { reason: `the contract's precision cannot represent ${delta}` };
  const next = value + step, limit = 10n ** BigInt(integerDigits + scale);
  if (next < 0n) return { reason: `${field} would fall below ${fromUnits(0n, scale)}` };
  if (next >= limit) return { reason: `${field} would exceed ${fromUnits(limit - 1n, scale)}` };
  return { record: { ...record, [field]: fromUnits(next, scale) } };
}

function toUnits(text, scale, signed) {
  if (typeof text !== 'string') return undefined;
  const match = (signed ? /^(-?)([0-9]+)(?:\.([0-9]+))?$/ : /^()(0|[1-9][0-9]*)(?:\.([0-9]+))?$/).exec(text);
  if (!match) return undefined;
  const [, sign, whole, fraction = ''] = match;
  // Record values need the contract's exact scale; a delta may be written shorter.
  if (signed ? fraction.length > scale : fraction.length !== scale) return undefined;
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign ? -units : units;
}

function fromUnits(units, scale) {
  const digits = units.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
