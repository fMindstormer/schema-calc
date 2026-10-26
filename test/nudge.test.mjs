import test from 'node:test';
import assert from 'node:assert/strict';
import { nudgeField } from '../src/nudge.mjs';
import { presets } from '../src/presets.mjs';

test('each preset shortcut turns its accepted record into exactly its rejected one', () => {
  for (const [name, preset] of Object.entries(presets)) {
    assert.deepEqual(nudgeField(preset.spec, preset.valid, preset.tamper), { record: preset.invalid }, name);
  }
});

test('the shortcut edits the current record, one field at a time, and repeats', () => {
  const { spec, tamper } = presets.invoice;
  const edited = { subtotal: '200.00', shipping: '0.00', discount: '0.00', total: '200.00' };
  const once = nudgeField(spec, edited, tamper).record;
  assert.deepEqual(once, { ...edited, total: '200.01' });
  assert.deepEqual(Object.keys(once), Object.keys(edited));
  assert.equal(nudgeField(spec, once, tamper).record.total, '200.02');
});

test('nudges use exact decimal arithmetic at the contract precision', () => {
  const spec = { fields: ['x'], constraints: ['x = x'], integerDigits: 4, scale: 2 };
  // 0.07 + 0.01 and 0.29 + 0.01 are classic binary floating-point traps.
  for (const [value, delta, expected] of [['0.07', '0.01', '0.08'], ['0.29', '0.01', '0.30'], ['999.99', '0.01', '1000.00'],
    ['1000.00', '-0.01', '999.99'], ['0.10', '-0.1', '0.00'], ['12.34', '2', '14.34']]) {
    assert.equal(nudgeField(spec, { x: value }, { field: 'x', delta }).record.x, expected, `${value} + ${delta}`);
  }
  const whole = { fields: ['x'], constraints: ['x = x'], integerDigits: 3, scale: 0 };
  assert.equal(nudgeField(whole, { x: '9' }, { field: 'x', delta: '1' }).record.x, '10');
});

test('the shortcut explains why it cannot apply instead of guessing', () => {
  const { spec, valid, tamper } = presets.invoice;
  const reason = (s, r, t = tamper) => nudgeField(s, r, t).reason;
  assert.match(reason({ ...spec, fields: ['a', 'b'], constraints: ['a = b'] }, valid), /no total field/);
  assert.match(reason({ ...spec, scale: 0 }, { ...valid, total: '122' }), /cannot represent 0.01/);
  assert.match(reason(spec, { ...valid, total: '9999.99' }), /exceed 9999.99/);
  assert.match(reason(spec, { ...valid, total: '0.00' }, { field: 'total', delta: '-0.01' }), /below 0.00/);
  for (const total of ['122.4', '0122.45', ' 122.45', 122.45, undefined]) assert.match(reason(spec, { ...valid, total }), /decimal string/);
  for (const record of [null, [], 'invoice']) assert.match(reason(spec, record), /JSON object/);
  assert.match(reason({ fields: [] }, valid), /contract is not valid/);
});
