# Validator compatibility

Schema Calc's claim is that its output needs no Schema Calc: any conforming Draft 2020-12 validator should give the arithmetic's answer. This directory tests that claim against independent validators in five languages. Each one runs **with its default options** on the same generated corpora as the [Python cross-check](../README.md#verification), and every answer is compared with the arithmetic.

<!-- results:start -->
| Validator | Language | Version | Flat input (31) | Tally input (36) | Shipped examples (6) |
|---|---|---|---|---|---|
| ajv | JavaScript | 8.20.0 | all 24,469 agree | all 24,473 agree | all 12 agree |
| @hyperjump/json-schema | JavaScript | 1.18.0 | all 24,469 agree | all 24,473 agree | all 12 agree |
| @exodus/schemasafe | JavaScript | 1.3.0 | all 24,469 agree | all 24,473 agree | all 12 agree |
| @cfworker/json-schema | JavaScript | 4.1.1 | refuses 23 of 31 schemas; the other 511 cases agree | all 24,473 agree | refuses 3 of 6 schemas; the other 6 cases agree |
| jsonschema | Python | 4.25.1 | all 24,469 agree | all 24,473 agree | all 12 agree |
| jsonschema-rs | Python | 0.60.3 | exceeds 2 GB on 11 of 31 schemas; the other 22,790 cases agree | all 24,473 agree | exceeds 2 GB on 3 of 6 schemas; the other 6 cases agree |
| github.com/santhosh-tekuri/jsonschema/v6 | Go | v6.0.3 | refuses 31 of 31 | all 24,473 agree | refuses 3 of 6 schemas; the other 6 cases agree |
| github.com/santhosh-tekuri/jsonschema/v6 *with ECMAScript regexp engine (dlclark/regexp2)* | Go | v6.0.3 | all 24,469 agree | all 24,473 agree | all 12 agree |
| github.com/kaptinlin/jsonschema | Go | v0.9.10 | refuses 31 of 31 | all 24,473 agree | refuses 3 of 6 schemas; the other 6 cases agree |
| com.networknt:json-schema-validator | Java | 3.0.8 | times out on 1 of 31 schemas; the other 23,767 cases agree | all 24,473 agree | times out on 1 of 6 schemas; the other 10 cases agree |
| dev.harrel:json-schema | Java | 1.9.1 | all 24,469 agree | all 24,473 agree | all 12 agree |
| com.github.erosb:json-sKema | Java | 0.32.0 | all 24,469 agree | all 24,473 agree | all 12 agree |
| JsonSchema.Net | C# | 9.5.0 | refuses 3 of 31 schemas; the other 23,755 cases agree | all 24,473 agree | refuses 2 of 6 schemas; the other 8 cases agree |
| JsonSchema.Net *with JSON nesting limit raised from 64 to 256* | C# | 9.5.0 | all 24,469 agree | all 24,473 agree | all 12 agree |
<!-- results:end -->

**No validator gave a wrong answer.** In all 14 configurations, every record a validator checked got the arithmetic's answer. The validators differ in which schemas they will load:

- **Every validator loaded every tally schema.** The [tally encoding](../docs/tally.md) uses no patterns or embedded resources and stays shallow, and all 24,473 cases agree everywhere.
- **Go's standard regexp (RE2) has no lookahead**, so both Go validators refuse every flat schema. Flat schemas end each decimal pattern with `(?![\s\S])`, an end-of-string test. `$` would be shorter, but in Python's `re`, Java and .NET it also matches before a final newline, so `"1.00\n"` would pass the shape check. santhosh-tekuri documents a drop-in ECMAScript engine; with it, the same library agrees on all 48,954 cases.
- **@cfworker/json-schema refuses nested embedded resources.** It refuses exactly the 23 flat schemas in which one embedded `$id` resource sits inside another, reporting `Duplicate schema URI`: its dereferencing reaches such a resource both from the enclosing resource and from the root. Each `$id` is declared once, and the other validators load these schemas.
- **JsonSchema.Net inherits System.Text.Json's limit of 64 nesting levels.** The shipped invoice schema is 85 levels deep, and the deepest corpus schema 91. Passing `new JsonDocumentOptions { MaxDepth = 256 }` to `JsonSchema.FromText` loads them, and every case agrees.
- **jsonschema-rs runs out of memory loading the larger flat schemas.** On 11 of the 31 (12 on the Linux CI runner), including all three shipped ones, it passes 2 GB while still loading; unlimited, the invoice schema reached nearly 4 GB within a minute without finishing. The flat schemas are small DAGs with heavily shared references, so this looks like expansion of shared subschemas at load time, but that is not verified. It loads the others in at most 3.1 s and agrees on every case.
- **networknt does not finish loading the invoice schema** within 120 seconds, with a 1 GB heap or without one. It loads every other schema and agrees on every case.
- **Loading time varies widely for the same file.** The 41 kB shipped invoice schema took 19.3 s to load in schemasafe, 4.8 s in Ajv with its default options and 2.1 s in json-sKema; every other validator that loaded it took under half a second. Python `jsonschema` builds lazily and pays instead while validating: 224–397 s for the flat corpus, against seconds for most compiled validators. These timings come from runs with three runners in parallel on an Apple Silicon Mac, and they only indicate scale.

For flat input today, the validators that load everything with defaults are Ajv, hyperjump and schemasafe (JavaScript), jsonschema (Python), and harrel and json-sKema (Java); JsonSchema.Net and santhosh-tekuri do with the one-line options above. Each refusal points at a choice the compiler could make differently: an end anchor without lookahead, shallower nesting, or no nested resources. Each would probably cost bytes, and none is attempted here.

## What is run

| Suite | Schemas | Cases | Source |
|---|---:|---:|---|
| Flat input | 31 | 24,469 | `test/corpus.json`, written by `npm test` |
| Tally input, including malformed encodings | 36 | 24,473 | `test/tally-corpus.json`, written by `npm test` |
| Shipped examples | 6 | 12 | `examples/*.schema.json` with their `valid` and `invalid` records |

A case agrees when the validator accepts exactly the records whose arithmetic holds. **Wrong** counts a validator accepting a false equation or rejecting a true one; any wrong answer fails the run. A validator that refuses to load a schema, or throws while validating a record, gives no answer for it; the table reports those separately and never counts them as agreement. Runners report when a schema has loaded and after every 100 records. A runner that reports nothing for 120 seconds, or spends 15 minutes on one schema, is recorded as timed out. One whose resident memory passes 2 GB is recorded as exceeding memory. Either way it restarts at the next schema. The limits keep slow validators from being penalised for the corpus size, and keep a stalled one from exhausting a CI runner. Java runs with a fixed 1 GB heap and a 16 MB thread stack, so the JVM's lazy garbage collection is not mistaken for validator memory use. `results.json` has each schema's peak memory as sampled, which is 0 for a schema that finished before the first sample.

Rows marked *with* change one documented default, to separate a validator's limits from the schemas' logic. Everything else is exactly what a new user of that library would write.

## Run it

Install the toolchains you want to test (Node.js, Python 3.13, Go, a JDK with Maven, the .NET SDK), then:

```sh
npm test                       # writes the two corpora
compat/setup.sh                # installs the pinned validators into bench/scratch/compat
npm run check:compat           # prints the comparison
npm run check:compat -- --write  # also updates results.json and the table above
```

`setup.sh` skips a toolchain that is missing, and the harness reports its rows as not run. `--only ajv,harrel` limits the run; `--require-all` fails if a runner is not installed. `COMPAT_TIMEOUT`, `COMPAT_SCHEMA_CAP` and `COMPAT_MEMORY_MB` set the limits above, and `COMPAT_JOBS` the number of runners at once. `--write` replaces only the rows that ran, and each row in [`results.json`](results.json) keeps its own date, platform, per-schema counts and error messages.

Versions are pinned in [`js/package.json`](js/package.json) with its lockfile, [`python/requirements.txt`](python/requirements.txt), [`go/go.mod`](go/go.mod) with `go.sum`, [`java/pom.xml`](java/pom.xml) and [`dotnet/Compat.csproj`](dotnet/Compat.csproj) with its lockfile.

## Runner protocol

Each runner is a small program in its own language: `<runner> <validator> <corpus.json> [first group]`. It prints one JSON line naming the validator, its version and runtime, then one line per schema as it finishes:

```json
{"index":1,"name":"invoice","cases":2016,"falseAccepts":0,"falseRejects":0,"caseErrors":0,"caseError":null,"error":null,"seconds":0.84}
```

`error` is the validator's message when it refuses the schema; `caseError` is the first exception thrown while validating a record. [`scripts/compat.mjs`](../scripts/compat.mjs) starts the runners, enforces the time limit, restarts after a timeout or crash, and writes the results.
