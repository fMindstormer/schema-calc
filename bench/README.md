# Reproducing the experiments

The supported compiler is `../src/compiler.mjs`. This directory retains frozen baselines, experimental compilers, emitted candidates and measured results. Experimental artifacts are not performance recommendations.

First follow the [development setup](../CONTRIBUTING.md). Commands below run from the repository root. Python npm scripts assume a macOS/Linux `.venv`; on Windows, use the corresponding Python file with `.venv\Scripts\python`.

## Commands and dependencies

| Run | What it does | Output |
|---|---|---|
| `npm test` | Core Ajv checks and local optimizer unit tests; creates both production corpora | Ignored `test/corpus.json`, `test/tally-corpus.json` |
| `npm run check:python` | Checks original exported schemas and records with Python | Printed pass totals |
| `npm run check:tally` | Checks tally schemas, records and malformed encodings with Python | Printed pass totals |
| `npm run benchmark` | Original, mixed-radix and packed examples in stock Ajv | `results.json` |
| `npm run benchmark:tally` | Mixed-radix, packed and tally in both validators; conversion separately | `tally-results.json` |
| `npm run check:flat-experiment` | Pair factorization against the original corpus in both validators | Ignored experimental corpus |
| `npm run benchmark:flat` | Same-input comparison with the pair experiment in both validators | `flat-results.json` |

Run `npm test` before any corpus-based check. Benchmark commands regenerate and overwrite their result files; keep a copy or use Git to compare a new run with the checked-in measurement. Earlier `mixed-radix-results.json` is a historical snapshot, while `benchmark` compares frozen source implementations in a new run.

The bounded superoptimizer is a longer, separate experiment:

```sh
npm test
npm run superoptimizer:screen
npm run superoptimizer:benchmark
npm run superoptimizer:check
npm run superoptimizer:confirm
```

Screening selects candidates for the broad benchmark. The benchmark writes its candidate fixtures and summary; confirmation uses those fixtures on new seeds and the original examples. The correctness check creates full-schema and exhaustive local fixtures and runs both validators. Search programs, results and confirmation samples are retained in `superoptimizer/`; large generated inputs go in ignored `scratch/` and `test/` files. These commands can take several minutes or longer. Do not run timing jobs concurrently.

## Reading the results

- Sizes mean compact, uncompressed UTF-8 JSON excluding the final newline, including all referenced resources. Tally input has a different representation; include its payload and conversion cost.
- Compiler time, validator preparation, warm accepted/rejected validation and conversion are different measurements. Python full-corpus correctness time is not a per-record benchmark. Its parallel optimizer verifier is not a speed benchmark at all.
- The early reports repeatedly time the original example pair. The optimizer reports use broader held-out workloads. Compare candidates within a report, not isolated values from different reports.
- The broad optimizer JSON retains initial `validMs` / `invalidMs` smoke timings as well as the actual benchmark. Use `ajv.<class>.medianMs` and `python.<class>.medianMs` for the held-out comparisons. Times are milliseconds per validation; multiply by 1,000 for microseconds.
- Read each file's methodology and environment fields. Most results were collected on macOS arm64 with Node 24.6.0, Ajv 8.20.0, Python 3.13.3 and jsonschema 4.25.1. Small differences are noisy. Recheck on the intended workload and validator.

The optimizer's six profiles repeat the corpus: 146,868 checks are not 146,868 distinct inputs. Every synthesized local program is exhaustively checked, but finite end-to-end testing is not a proof for all contracts. The proof obligation is described in [../docs/design.md](../docs/design.md) and [../docs/superoptimizer.md](../docs/superoptimizer.md).

No searched candidate survived the joint size/no-slowdown confirmation gate against the default compiler. `superoptimizer/artifacts/*.candidate.schema.json` remains explicitly experimental. `experimental/hybrid-compiler.mjs` passed only example smoke checks and was rejected for runtime; it is not a verified alternative. Some earlier rejected prototypes survive only as documented measurements, not runnable implementations; see [../docs/experiments.md](../docs/experiments.md).
