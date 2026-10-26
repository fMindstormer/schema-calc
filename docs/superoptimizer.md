# Bounded superoptimization of flat-input arithmetic

This experiment searches arithmetic decision programs and emits ordinary JSON Schema Draft 2020-12. Inputs retain exactly the existing flat object, field names, canonical decimal strings, precision, and arithmetic contract. There is no tally conversion, carry witness, custom keyword, remote schema, or validator patch. Production remains `src/compiler.mjs`.

## Search space

`bench/superoptimizer/search.mjs` synthesizes a decision program from a complete finite truth table. The compiler supplies each row's correct next carry continuation, or rejection, using the existing signed mixed-radix invariant.

- Binary stages with at most four fields: search the entire stage (at most 16 rows).
- Quinary stages: search the final two fields (25 rows); earlier fields retain the existing compiler's decisions.
- Tests: every subset of a field's component values, plus native `oneOf` over every subset and polarity of two to four binary fields. Two-child `oneOf` is XOR; larger `oneOf` means exactly one, not parity.
- Programs: a constant or symbolic continuation, or a conditional with two smaller decision programs. Continuations remain ordinary schema references and are not supplied by the input.

Memoized dynamic programming considers every distinct nontrivial partition of each reachable row set induced by the retained tests. It scores a program by an additive byte estimate plus a weighted estimate of primitive tests, using uniform local rows. The tested work weights are 0, 24, 100, 400 and 1600 for binary search, and 0, 24 and 400 for pair/combined search. The state budget is 70,000 per local search; exhausting it falls back to the existing decision construction.

This is a bounded superoptimizer, not a search over all JSON Schema programs. Its score is a proxy: shared definitions, emitted reference lengths, interpreter overhead, and validator short-circuit behavior can change the real cost. Final candidates are compared using actual serialized UTF-8 bytes and actual validation time. Smallest proxy cost does not imply smallest document or fastest validator.

For a stage with radix R, the original transition rejects when the signed component sum is not divisible by R; otherwise it follows the sum/R continuation. The complete table enumerates every component tuple. A synthesized program that selects the same label on every row preserves that transition, and substituting these transitions preserves the existing carry invariant. This argument concerns the arithmetic rewrite; the exported-schema checks separately exercise emission, formats and reference resolution.

Every emitted local program is exhaustively checked against its supplied truth table. `programs.json` records the programs and tables. Additional small schemas exercise their standard Boolean keywords on every row and all-false, all-true, and one-hot continuation assignments. Full exported schemas are checked separately against the existing independently generated arithmetic corpus, plus precision, term-count and field-count stress cases.

## Controls and benchmark

The comparison includes the earlier fast mixed-radix compiler, current production compiler, previous pair-factorization experiment, and a layout-only control using current digit predicates with flat `$defs` references. Both the flat-reference and packed-resource layouts are searched. The word "flat" in a layout name concerns the schema's structure; **all variants accept the same original flat input**.

Screening searches binary stages, quinary pairs, and both together, with a no-`oneOf` ablation. Identical emitted schemas are deduplicated. A candidate that is already larger than its established layout baseline cannot pass the joint size/speed criterion and is excluded from the longer timing pass.

The held-out workload has 32 accepted records, 32 arithmetic errors spread across decimal positions, and eight malformed inputs per example. It is generated independently of the compiler and checked against a separate integer oracle. It includes zeroes, boundary values, changing magnitudes, and long carries. This is a broader workload than repeatedly timing the original single example, so its times should not be compared directly with older reports.

Ajv runs each candidate in a fresh process, with `strict: true` and `inlineRefs: false`, 10,000 warmups per workload class, and nine batches of 8,192 validations per class. Python uses unmodified `Draft202012Validator.is_valid`, checks the meta-schema, warms the full workload, and uses seven rounds with rotated candidate order. Compilation, schema checking and preparation are excluded from warm validation timings. Ajv preparation and Python constructor plus first accepted validation are reported separately.

Promising candidates receive a single confirmation pass on two new deterministic input seeds, with candidate order reversed for the second seed. The original accepted/rejected example records are included as separate timing classes, so an average gain on random inputs cannot hide a regression on the original example. Python repeats the very short malformed-input workload 512 times per confirmation round. The candidate set is declared before the confirmation; results are not used for further tuning.

The gate checks accepted, arithmetic-invalid, and malformed medians separately in both validators. It reports both the literal no-higher-medians condition and a separate 5% near-tie band. That band is not proof of no slowdown, and no timing result proves a speed bound for all possible inputs. There is no automatic production promotion.

## Reproduce

```sh
npm test
npm run superoptimizer:screen
npm run superoptimizer:benchmark
npm run superoptimizer:check
npm run superoptimizer:confirm
```

`bench/superoptimizer/results.json` retains samples and comparisons. `verification.json` records the JavaScript checks and exhaustive local search statistics; the Python commands print their own independently checked totals. The Python correctness runner uses four worker processes; its elapsed time is not a validation-speed benchmark. Large regenerated validation corpora and benchmark inputs are ignored by Git. Search programs and aggregate results are retained for inspection.

## Results

The smallest searched documents were:

| Example | Production | Previous pair experiment | Smallest searched | Production → searched Ajv accepted | Production → searched Python accepted |
|---|---:|---:|---:|---:|---:|
| Invoice | 41,232 B | 38,592 B | 39,798 B | 6.25 → 6.49 µs | 24.98 → 47.45 ms |
| Allocation | 16,315 B | 16,068 B | 15,893 B | 2.19 → 2.68 µs | 11.40 → 20.91 ms |
| Carry | 20,510 B | 20,232 B | 19,979 B | 3.34 → 3.63 µs | 18.78 → 20.40 ms |

These minima save 3.48%, 2.59% and 2.59% against production, respectively, but none passes the joint speed gate. The invoice is also larger than the previous 38,592-byte pair experiment. The earlier fast mixed-radix backend remains a separate, substantially faster Python baseline; none of the candidates passed the broad joint gate against it.

The broad pass found two potentially useful carry compromises: 20,305 B (`packed-both-24`, 1.00% smaller than production) and 20,411 B (`packed-both-400`, 0.48% smaller). They had lower medians in every measured class in both validators in that pass. The confirmation pass did **not** reproduce those as reliable joint improvements. A 40,542-byte invoice candidate and a 16,023-byte allocation candidate are also checked there; the allocation candidate is compared with the earlier pair experiment as well as production.

`artifacts/*.candidate.schema.json` contains the size minima, explicitly labeled as experimental in the manifest. Their presence does not imply a performance recommendation. Production remains unchanged.


## Correctness results

All 24 Node tests passed. Six compiler profiles were checked on the original 24,469-case corpus plus nine stress cases: **146,868 full-record checks across 204 schemas**, covering 34 source contracts, passed in both stock validators. Python checked all 204 schemas against the Draft 2020-12 meta-schema. The additional cases cover twelve-digit arithmetic, sixteen source terms and eight fields.

The local search run checked **342 synthesized programs**, exploring 954,516 memoized states and 16,038,380 partitions, with no search-budget fallbacks. Its 1,328 local schema fixtures passed **22,828 cases in both validators**, including Python meta-schema checks. The budget-fallback path is tested separately with a deliberately tiny budget. The three examples also passed an additional smoke check using Ajv's default options.

These are repeated checks across six profiles, not 146,868 distinct input records. Exhaustive local transition checks support the carry-preservation argument; the finite end-to-end corpus is not an exhaustive proof of every supported source contract.


## Confirmation and decision

**No candidate passed the joint no-slowdown criterion against production on both new input seeds and the original examples.** This also holds with the reported 5% near-tie allowance. The initial carry wins were specific to the first workload.

| Candidate | Bytes | Largest confirmed Ajv ratio to production | Largest confirmed Python ratio to production |
|---|---:|---:|---:|
| invoice / packed-binary-1600 | 40,542 | 1.46× | 1.00× |
| allocation / packed-binary-1600 | 16,023 | 1.07× | 1.00× |
| carry / packed-binary-24 | 19,979 | 1.19× | 2.83× |
| carry / packed-both-24 | 20,305 | 1.14× | 2.47× |
| carry / packed-both-400 | 20,411 | 1.07× | 1.32× |

Ratios above 1 indicate slower validation. Each column shows the largest ratio across the two seeds and all five workload classes, so the Ajv and Python maxima may come from different classes. Small differences are noisy; the larger regressions rule out a general win. The complete samples, class-specific ratios and preparation times are retained in `confirmation.json` and `results.json`.

Against the prior pair experiment, the 16,023-byte allocation candidate saves only 45 bytes and stays within the confirmation's 5% band, but does not meet the literal no-higher-medians condition. This is not a reason to replace the current production backend. None of the broad candidates dominated the earlier fast mixed-radix backend either.

The optimizer, emitted candidates, exhaustive local certificates and reproducible checks are retained as an experiment. The production compiler and browser remain unchanged. These results constrain this grammar and cost model; they establish neither an impossibility result nor a lower bound for standard JSON Schema.
