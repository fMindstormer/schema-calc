# Arithmetic by counting, with a recursive carry automaton

The optional tally encoding replaces positional digit regexes with native JSON Schema cardinality checks. The invoice schema is **3,569 bytes**, allocation **3,913 bytes**, and carry **2,356 bytes**, including every definition. These are ordinary Draft 2020-12 schemas, with local static `$ref` links and no custom keywords or validator hooks.

**This changes the data representation.** It does not shrink a schema that directly accepts the original flat decimal-string object. The original compiler remains the default. Both representations cover exactly the same bounded numeric values and equations; `encodeTally` preserves the supplied total, even when it is wrong. An application must pass the encoded record to the tally schema.

## Representation

Each decimal column is an object with two properties:

```text
{ "d": [tally tokens for this column], "$": next column or null }
```

Columns run from least to most significant. There are exactly `integerDigits + scale` columns. Each field has a distinct positive integer tag. Its digit `d` is represented by nine tokens: `d` copies of the positive tag and `9-d` copies of the negative tag. For tag 1, digit 3 is `[1,1,1,-1,-1,-1,-1,-1,-1]`. The nine slots belonging to a field may contain only that tag and its negation.

Token order inside a block does not affect its value. The encoder chooses positive tokens first; the decoder accepts any ordering with the same count. Consequently, conversion is lossless but not a bijection over every accepted token permutation. It performs no addition of source fields and supplies no carries, totals, or arithmetic certificates.

The input grows. The example invoice increases from 75 to 676 compact JSON bytes; allocation from 63 to 566; carry from 56 to 515. This is a schema-size/input-size tradeoff, suitable when a small portable validator artifact matters and the application controls serialization.

## Native counting performs the digit sum

Normalize an equation to `Σ cᵢ xᵢ + k = 0`. First consider coefficients `+1` and `-1`. A `contains` subschema selects the positive tag for a positive term and the negative tag for a negative term. If `K` tokens match and there are `N₋` negative terms, then:

```text
K = Σpositive dᵢ + Σnegative (9 - dᵢ)
K - 9N₋ = Σ cᵢ dᵢ
```

Thus an exact count, expressed by equal `minContains` and `maxContains`, checks a signed digit sum. These are [standard array keywords](https://json-schema.org/understanding-json-schema/reference/array#contains).

Given incoming carry `r`, enumerate the possible counts `K` for which `r + K - 9N₋` is divisible by ten. Each matching count advances to carry `(r + K - 9N₋) / 10` on the child column. The division and state enumeration happen only at compilation time. At validation time, the schema counts tokens and selects a precompiled branch.

Each carry state is one reusable `$defs` entry. Its recursive `$ref` applies to the `$` child, consuming a column; it never recurses on the same instance. The invoice needs just three carry states, allocation three, and the carry example two. Increasing precision adds shape checks, rather than duplicating the arithmetic machine at every position. See the standard's [recursive schema guidance](https://json-schema.org/understanding-json-schema/structuring#recursion).

## Constants and repeated coefficients

A nonzero combined constant gets a dedicated tally block in every column. The shape schema fixes its exact digit count at every position. Its sign participates in the selected-tag set like any other term. These blocks cannot be forged to change the contract: the validator checks their literal values independently of arithmetic.

For a coefficient with magnitude greater than one, the field has repeated tally blocks. A shape rule requires every copy to have the same count as its primary block. Each equation selects as many copies as its coefficient requires. This also ties shared field values across multiple equations. Without those consistency checks, `a + a = total` could accept separate copies representing 2 and 3 with total 5; the tests explicitly reject that attack.

The source language and its limits are the same as for flat input, including signed intermediate carries, repeated terms, constants that sum beyond one field's width, and multiple simultaneous equations, with one exception. A coefficient of `k` needs `k` copies of the field, and each carry decision lists every copy, so the schema grows roughly with `k³`: for `total = k * price + shipping` it is 2.3 kB at `k` = 1, 38 kB at 10 and 87 kB at 16. The tally encoding therefore refuses coefficients above 16, the most that 16 source terms could produce before explicit coefficients existed. Flat input accepts coefficients up to 1,000.

## Correctness invariant

The shape rules give every field exactly one digit in `0..9` at each of `D` positions. Repeated copies agree, literal constant digits are fixed, and there are no extra slots, properties, or columns. Therefore every shape-valid record decodes to values in `[0, 10ᴰ)` with the declared decimal scale.

Let `kⱼ` be the signed digit of the combined constant, and let `Pⱼ` be the signed contribution of all columns below `j`. Start at `r₀ = 0`. The invariant is `Pⱼ = 10ʲ rⱼ`. Native counting gives the exact next balance:

```text
sⱼ = rⱼ + Σ cᵢ dᵢⱼ + kⱼ = rⱼ + Kⱼ - 9N₋
```

If it is not divisible by ten, no higher column can repair the remainder. Otherwise `rⱼ₊₁ = sⱼ / 10` preserves the invariant. At the null terminator the schema accepts only carry `-trunc(k / 10ᴰ)`. This accounts for any constant digits beyond the field width, and makes acceptance equivalent to the original equality. Overflow and negative results cannot wrap to a valid answer.

## Why validation stays manageable

Each count uses `if`/`then`/`else`. A successful count follows exactly one next-column reference. Rejected counts do not inspect the tail. A prototype using recursive alternatives inside `anyOf` was much slower in Python because failed alternatives still traversed their tails; it was discarded.

For a fixed contract, validation follows a number of count predicates proportional to the number of columns. This does not promise a particular validator implementation's constant factors. It avoids the repeated evaluation of recursive arithmetic expressions that made the earlier small Boolean-circuit prototypes unusable.

Small token enums are inlined: they are shorter than a reference and avoid a reference resolution for every token. The tally file uses a flat `$defs` table rather than embedded resource IDs. Stock Ajv and Python validate it directly, with no preparation transform.

## Use

```sh
node bin/schema-calc.mjs --tally examples/invoice.contract.json invoice.tally.schema.json
node bin/schema-calc.mjs --encode-tally examples/invoice.contract.json examples/invoice.valid.json invoice.tally.json
node bin/schema-calc.mjs --decode-tally examples/invoice.contract.json invoice.tally.json
```

```js
import Ajv2020 from 'ajv/dist/2020.js';
import { compileTally, encodeTally, decodeTally } from './src/tally.mjs';

const { schema } = compileTally(contract);
const payload = encodeTally(contract, record);
const validate = new Ajv2020({ strict: true, inlineRefs: false }).compile(schema);
console.log(validate(payload));
console.log(decodeTally(contract, payload)); // the supplied record, even if arithmetic is wrong
```

```python
import json
from jsonschema import Draft202012Validator

with open('examples/invoice.tally.schema.json') as f:
    schema = json.load(f)
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
with open('examples/invoice.tally.valid.json') as f:
    assert validator.is_valid(json.load(f))
with open('examples/invoice.tally.invalid.json') as f:
    assert not validator.is_valid(json.load(f))
```

The playground offers **Validation format → Compact tally JSON**, shows the exact JSON passed to Ajv, and downloads the schema and validation record separately. It keeps the decimal-string editor for readability and labels the representation change explicitly.

## Reproduce the measurements and verification

```sh
npm test
npm run check:tally
npm run benchmark:tally
```

The **20 core compiler tests** pass; the complete Node suite now has 24 tests, including four for the superoptimizer. The tally corpus contains **24,473 records across 36 schemas**, checked by stock Ajv and stock Python `jsonschema`, with Python also checking every schema against the Draft 2020-12 meta-schema. It includes exhaustive one-digit addition and every pair of two-digit addends, independent BigInt oracle cases, signed coefficients, constants, repeated terms, multiple equations, malformed wire inputs, forged literals and copies, and boundary stress cases. The final Python run took **19.54 seconds**, versus the previously recorded packed corpus run of **69.53 seconds**. Corpus totals differ slightly because malformed source strings have no tally encoding and tally-specific malformed records were added.

[bench/tally-results.json](../bench/tally-results.json) compares the earlier fast mixed-radix encoding, packed encoding, and tally encoding on the same three example values. It records input sizes, stock Ajv preparation, warm accepted/rejected validation in both engines, and complete JavaScript conversion time separately. Conversion time must be added if the application starts with the original flat record; validator-only timings are not end-to-end application timings. Results are local measurements, not universal guarantees or a novelty claim.

The recorded accepted-record timings are:

| Example | Packed Ajv → tally Ajv | Packed Python → tally Python | JS encoding, extra |
|---|---:|---:|---:|
| Invoice | 3.52 → 1.46 µs | 16.55 → 2.61 ms | 17.41 µs |
| Allocation | 1.48 → 3.89 µs | 20.74 → 1.73 ms | 15.14 µs |
| Carry | 2.16 → 1.07 µs | 19.61 → 1.12 ms | 14.53 µs |

Invoice preparation in stock Ajv fell from 2.96 s to 17.3 ms in this run. Compared with the earlier **57,050-byte fast mixed-radix** invoice, tally validation was faster in Ajv (2.85 → 1.46 µs) and slower in Python (1.77 → 2.61 ms). Allocation is slower in Ajv even relative to the packed format. The improvement is therefore compact schemas without the packed format's severe setup/interpreter penalty, not faster validation in every case. For an application converting each flat invoice immediately before validating, the measured JavaScript conversion-plus-validation cost is about 18.9 µs.
