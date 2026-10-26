# A second round of schema compression

The input format and numeric bounds stayed unchanged. The objective was to reduce uncompressed standard JSON Schema, including every resource needed to validate it.

## Adopted: first-use resource declarations

The arithmetic still uses the radix-2/radix-5 carry graph. The new representation declares a shared node with `$id` at its first use, then uses short relative `$ref` links. It removes both the separate definition entry and its first reference. Zero-excluding digit predicates also remove padding alternatives and shorten suffix patterns.

| Example | Previous | Packed | Further reduction |
|---|---:|---:|---:|
| Invoice | 57,050 B | 41,232 B | 27.7% |
| Allocation | 21,935 B | 16,315 B | 25.6% |
| Carry | 28,167 B | 20,510 B | 27.2% |

These are standard Draft 2020-12 Compound Schema Documents. All references resolve within the single file. Both validators passed the full 24,469-record corpus. The proof and resource-scope rules are in DESIGN.md.

The tradeoff is real: stock Ajv invoice preparation increased from about 78 ms to 1.90 s in the recorded comparison, and warm validation from 4.6 to 16.7 microseconds. The browser's in-memory unbundling/preparation took about 95 ms. Python's default full-corpus run took 69.53 s, versus about 5.8 s in the preceding implementation. See bench/results.json for the current benchmark and bench/mixed-radix-results.json for the previous run. These local timings are indicative, not controlled cross-machine results.

## Investigated and rejected

- **Boolean arithmetic circuits.** Two-input `oneOf` implements XOR. Full adders, decimal-complement operands, and bounded carries produced a 24,444-byte invoice after packing. But ordinary validators repeatedly traverse shared expressions: a single accepted invoice took about 22.5 seconds in Python in a smoke measurement. That representation was rejected despite its size. The prototype was not fully verified and is not shipped as a supported compiler.
- **Local carry checkpoints.** Recovering carries from a column's quotient sum cut repeated traversal. A packed circuit reached 29,949 bytes for the invoice, but the same Python smoke case still took about 331 ms. It also gave much smaller savings on the other two examples.
- **Bit-interleaved digit decisions.** Reading individual binary bits of decimal digits increased the invoice to 75,236 bytes because the abstraction introduced additional intermediate states.
- **Reversed mixed radix.** Reading radix 5 before radix 2 produced 57,541 bytes, slightly larger than the previous 57,050-byte encoding.
- **Independent local congruences and carry recovery.** Splitting column checks modulo 2 and 5 removed some long dependencies, but duplicated enough local logic to increase the artifact size.

The smaller circuit figures are candidate measurements, not claims of a production-ready, fully verified alternative. The selected encoding passed the complete tests, but no global size optimality is claimed. A further large reduction will need a representation that shares arithmetic without making general validators repeatedly evaluate a deep circuit.

## Third round: count tally tokens and reuse arithmetic recursively

The new optional encoding makes a different tradeoff: transform the input record losslessly, represent each decimal digit by a nine-token tally, and use standard `contains` counts as the arithmetic primitive. Linked columns allow one tiny carry automaton to be reused at every position. The invoice is 3,569 B, allocation 3,913 B, and carry 2,356 B. The original flat record format is still available.

The schemas enforce repeated-copy consistency, fixed constants, exact column count and token domains; no arithmetic witness or user-provided carry is trusted. `if`/`then`/`else` follows one carry path. A recursive `anyOf` prototype was rejected after showing repeated traversal of failed tails. Inlining tiny token enums further reduced both size and interpreter overhead.

All 20 Node tests pass, and 24,473 tally records across 36 schemas pass both stock validators. Final Python corpus time was 19.54 s. The invoice input grows from 75 to 676 B, and conversion costs extra. [tally.md](tally.md) gives the proof and usage; [../bench/tally-results.json](../bench/tally-results.json) separates validation, conversion, preparation and payload size. This is not a result for unchanged flat JSON, nor a universal speed improvement over the earlier fast mixed-radix compiler.

## Fourth round: original flat input, without conversion

A local Boolean-circuit/explicit-carry hybrid reached a 34,961-byte invoice but remained too slow (about 288 ms for an accepted Python smoke case). Factoring the final two radix components into a shared modular equality produced a more useful but modest result: 38,592 B for invoice, 16,068 B for allocation, and 20,232 B for carry. It passed all 24,469 unchanged flat records across 31 schemas in stock Ajv and Python, including Python meta-schema checks. The full Python run took 74.45 s. The production compiler was not replaced.

The 2–4 kB target for unchanged flat JSON was **not achieved**. [flat-experiment.md](flat-experiment.md) explains the identity, rejected alternatives and reproducibility; [../bench/flat-results.json](../bench/flat-results.json) compares validation and preparation on identical inputs in both engines.


## Fifth round: bounded superoptimization

The new experiment searches complete local arithmetic truth tables with field-subset predicates, standard `oneOf` tests, and conditional programs. It checks every synthesized program, measures both flat-reference and packed-resource layouts, and includes the previous implementations as controls. The smallest candidates are 39,798 B (invoice), 15,893 B (allocation), and 19,979 B (carry); they regress in validation time. Small apparent carry improvements in the initial workload failed confirmation on new records and the original examples.

Six profiles passed 146,868 full-schema checks across 204 schemas in both validators, plus 22,828 local checks. Python checked the schemas against Draft 2020-12. No candidate met the confirmed no-slowdown criterion against production, so production remains unchanged. [superoptimizer.md](superoptimizer.md) describes the bounded search, measured trade-offs, confirmation and commands; `bench/superoptimizer/` contains the implementation, candidate schemas, search certificates and results.
