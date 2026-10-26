# Flat-input arithmetic experiments

This round did **not** reproduce the tally encoding's 2–4 kB schemas for the original flat JSON. The production compiler and playground were left unchanged. No tally conversion, auxiliary fields, reduced precision, external schema library, or custom validator keyword is used by the flat experiments.

## Factoring the last two operands

The most useful candidate replaces some decision-tree leaves with a shared modular equality. At a radix-2 or radix-5 stage, complement the final two unit-coefficient components as necessary to obtain `x,y` in `[0,R)`, and adjust the balance to `b`. Set `r = (-b) mod R`.

```text
b + x + y is divisible by R
    iff x = (r - y) mod R

On those matching inputs:
(b + x + y) / R = (b + r) / R + [x > r]
```

The schema compares the binary codes of `x` and `(r-y) mod R`. Each corresponding bit pair must agree: `not: {oneOf: [bitX, bitY]}` is standard Boolean equivalence. A separate digit-set test selects whether the sum wraps. Only the selected carry continuation is evaluated.

Negative coefficients of magnitude one use the complement `R-1-component`; other coefficients retain the existing transition construction. Equality checks are interned independently of carry continuations, allowing reuse for different balances with the same residue. The original root format restrictions, numeric bounds, high-constant handling and final carry condition remain intact. The original carry invariant therefore applies once the replacement transition identity above is established.

The experimental compiler tries no factoring, parity-only factoring, quotient-only factoring, and both stages. It selects the smallest compact JSON for the declared field order. Selection minimizes bytes, not runtime. Exhaustively trying field orders on the three examples saved no additional invoice bytes and only 9/98 bytes for allocation/carry, so field reordering was not adopted.

| Example | Production flat schema | Selected experiment | Reduction |
|---|---:|---:|---:|
| Invoice | 41,232 B | 38,592 B | 6.4% |
| Allocation | 16,315 B | 16,068 B | 1.5% |
| Carry | 20,510 B | 20,232 B | 1.4% |

The ordinary invoice record remains 75 bytes, allocation 63, and carry 56. These files do not accept a different numeric encoding. This is a modest factorization result, not a solution to the requested 2–4 kB target.

## Rejected local-circuit hybrid

A separate prototype computes each decimal column with Boolean full adders and dispatches an explicit carry state. This prevents arithmetic circuits from recursively recalculating carries through all prior columns, but shared expressions still get reevaluated within a column.

The packed invoice reached 34,961 bytes. Smoke measurements gave roughly 190 microseconds for warm Ajv validation and 288 milliseconds for one accepted Python validation. Allocation and carry were larger than their production schemas. The prototype passed only the three valid/invalid example pairs in both engines and Python meta-schema checks; it was rejected before full-corpus verification. It is retained under `bench/experimental/hybrid-compiler.mjs` solely for reproducibility, not as a supported compiler.

Parameterized sharing through dynamic references was also investigated. It is not a drop-in generic-function mechanism here: the installed Ajv implementation records dynamic-anchor bindings in a shared validation context, so independently rebinding the same names for each decimal position cannot be assumed portable. Static `$anchor` packing was rejected by the installed Ajv's default strict schema checks. An alternative using `$dynamicAnchor` declarations and static references was abandoned during very slow preparation. None of these routes is part of the checked candidate.

## Reproduction

```sh
npm test
npm run check:flat-experiment
npm run benchmark:flat
```

`npm test` regenerates the original independent-oracle corpus, now including its source specifications. The experimental verifier compiles those same specifications and passes the original records directly to stock Ajv. Python checks the resulting unchanged records independently and checks every generated schema against the Draft 2020-12 meta-schema. The production compiler's existing 20 tests still pass.

The selected experiment passed **24,469 original records across 31 schemas in both validators**. Python's full run took **74.45 seconds**. Coverage includes exhaustive one-digit addition, every two-digit addend pair, independently generated signed linear equations, repeated terms, multiple constraints, constant overflow, carries/borrows, malformed original JSON and precision boundaries. This finite corpus complements the transition identity; it is not a proof by exhaustive testing of the full supported domain.

`bench/flat-results.json` records original-JSON sizes, accepted and rejected validation timings in both engines, and Ajv preparation times for the earlier fast mixed-radix compiler, production packed compiler, and selected experiment. Timing uses unmodified validators without the browser preparation helper. Generated example artifacts are saved in `bench/experimental/*.pair.schema.json`.

Measured accepted-record timings (production packed → selected experiment):

| Example | Ajv | Python jsonschema |
|---|---:|---:|
| Invoice | 2.71 → 3.95 µs | 12.00 → 14.00 ms |
| Allocation | 1.19 → 1.51 µs | 15.82 → 15.76 ms |
| Carry | 1.84 → 1.83 µs | 15.36 → 19.74 ms |

Invoice Ajv preparation improved from 2.28 s to 1.32 s, but allocation/carry preparation did not improve. Warm validation has no consistent gain and regresses on some cases. Together with the small size reduction, these measurements do not justify replacing the production encoding. The earlier larger mixed-radix schemas remain substantially faster in Python (about 0.77–1.34 ms for these accepted records). These are local measurements with the methodology and rejected-record timings recorded in the results file.

No lower bound or impossibility claim follows from these experiments. The result is that the investigated flat encodings did not achieve a comparable size reduction, and the smaller circuit candidate had an unacceptable runtime cost.
