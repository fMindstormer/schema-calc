# Validator compatibility

Schema Calc's claim is that its output needs no Schema Calc: any conforming Draft 2020-12 validator should give the arithmetic's answer. This directory tests that claim against independent validators in five languages. Each one runs **with its default options** on the same generated corpora as the [Python cross-check](../README.md#verification), and every answer is compared with the arithmetic.

<!-- results:start -->
| Validator | Language | Version | Flat input (64) | Flat input, `$defs` layout (64) | Tally input (66) | Shipped examples (6) |
|---|---|---|---|---|---|---|
| ajv | JavaScript | 8.20.0 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| @hyperjump/json-schema | JavaScript | 1.18.0 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| @exodus/schemasafe | JavaScript | 1.3.0 | times out on 2 of 64 schemas; the other 30,781 cases agree | times out on 1 of 64 schemas; the other 30,941 cases agree | all 30,622 agree | all 12 agree |
| @cfworker/json-schema | JavaScript | 4.1.1 | refuses 51 of 64 schemas; the other 697 cases agree | all 31,101 agree | all 30,622 agree | refuses 3 of 6 schemas; the other 6 cases agree |
| jsonschema | Python | 4.25.1 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| jsonschema-rs | Python | 0.60.3 | exceeds 2 GB on 32 of 64 schemas; the other 27,274 cases agree | exceeds 2 GB on 28 of 64 schemas; the other 27,657 cases agree | all 30,622 agree | exceeds 2 GB on 3 of 6 schemas; the other 6 cases agree |
| github.com/santhosh-tekuri/jsonschema/v6 | Go | v6.0.3 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| github.com/kaptinlin/jsonschema | Go | v0.9.10 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| com.networknt:json-schema-validator | Java | 3.0.8 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| dev.harrel:json-schema | Java | 1.9.1 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| com.github.erosb:json-sKema | Java | 0.32.0 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
| JsonSchema.Net | C# | 9.5.0 | all 31,101 agree | all 31,101 agree | all 30,622 agree | all 12 agree |
<!-- results:end -->

**No validator gave a wrong answer.** In every configuration, every record a validator checked got the arithmetic's answer. The validators differ only in which schemas they will load:

- **Nine of the twelve load every schema with the default layout**, and @exodus/schemasafe loads all but the two largest. Version 0.1.0's schemas were refused by four of those nine. Both Go validators refused every flat schema, because Go's standard regexp (RE2) has no lookahead and the end-of-string test was `(?![\s\S])`. JsonSchema.Net stopped at System.Text.Json's limit of 64 nesting levels, which the invoice exceeded at 85. networknt did not finish loading the invoice within two minutes. The compiler now checks the end of a field with `$` plus a second pattern, `not: {pattern: "[^.0-9]"}` (in Python, Java and .NET `$` alone would also match before a final newline), and keeps every file within 32 levels. That costs 95–132 bytes per example; see [design.md](../docs/design.md#domain).
- **@cfworker/json-schema refuses resources embedded inside other resources.** It rejects exactly the 51 flat schemas in which one embedded `$id` resource sits inside another, reporting `Duplicate schema URI`: its dereferencing reaches such a resource both from the enclosing resource and from the root. The schemas are valid, and the other validators load them. With `compile(spec, { layout: 'defs' })` or `--defs`, every shared resource is declared in a root `$defs` instead; cfworker then loads every schema and agrees on every case, at 17–20% more bytes.
- **@exodus/schemasafe times out on the two schemas with large coefficients.** They compile `100 * a` and `1000 * a` into 333 kB and 911 kB, and schemasafe reports nothing for longer than the harness's 120-second limit while loading them. Timed separately, it loads the 333 kB schema in 159 s, or 46 s with the `$defs` layout, and the 911 kB one in 11 minutes, or 10 with `$defs`. It gets every answer right. The other validators that load them take under 20 s.
- **jsonschema-rs runs out of memory loading the larger flat schemas** in either layout: it passes 2 GB while still loading 32 of the 64 (28 with `$defs`; one more in each on the Linux CI runner), including all three shipped ones. Unlimited, the 0.1.0 invoice reached nearly 4 GB within a minute without finishing. The flat schemas are small DAGs with heavily shared references, so this looks like expansion of shared subschemas at load time, but that is not verified. The nesting limit does not change it: on the 31 schemas before coefficients were added, between 16 and 56 levels, 9 to 11 still exceeded 2 GB. It loads the others in seconds and agrees on every case.
- **Every validator loads every tally schema.** The [tally encoding](../docs/tally.md) uses no patterns or embedded resources and stays shallow, and all 30,622 cases agree everywhere.
- **Loading time varies widely for the same file.** The 41 kB shipped invoice took 4.3 s to load in schemasafe, 0.9 s in Ajv with its default options and 0.4 s in networknt; every other validator that loaded it took under a quarter of a second. The `$defs` layout loads faster in most of them: 0.8 s in schemasafe and 0.2 s in Ajv. The 911 kB coefficient schema took 7.5 s in Ajv, 12 s in the santhosh-tekuri Go validator and 9.1 s in harrel. Python `jsonschema` builds lazily and pays instead while validating: four to six minutes for each flat suite, against seconds for most compiled validators. These timings come from runs with three runners in parallel on an Apple Silicon Mac, and they only indicate scale.

Each refusal or timeout comes from a validator limitation rather than the schemas' logic. The table shows which layout avoids it; for schemasafe and jsonschema-rs, smaller schemas do.

## What is run

| Suite | Schemas | Cases | Source |
|---|---:|---:|---|
| Flat input | 64 | 31,101 | `test/corpus.json`, written by `npm test` |
| Flat input, `$defs` layout | 64 | 31,101 | The same contracts compiled with `layout: 'defs'` by the harness |
| Tally input, including malformed encodings | 66 | 30,622 | `test/tally-corpus.json`, written by `npm test` |
| Shipped examples | 6 | 12 | `examples/*.schema.json` with their `valid` and `invalid` records |

A case agrees when the validator accepts exactly the records whose arithmetic holds. **Wrong** counts a validator accepting a false equation or rejecting a true one; any wrong answer fails the run. A validator that refuses to load a schema, or throws while validating a record, gives no answer for it; the table reports those separately and never counts them as agreement. Runners report when a schema has loaded and after every 100 records. A runner that reports nothing for 120 seconds, or spends 15 minutes on one schema, is recorded as timed out. One whose resident memory passes 2 GB is recorded as exceeding memory. Either way it restarts at the next schema. The limits keep slow validators from being penalised for the corpus size, and keep a stalled one from exhausting a CI runner. Java runs with a fixed 1 GB heap and a 16 MB thread stack, so the JVM's lazy garbage collection is not mistaken for validator memory use. `results.json` has each schema's peak memory as sampled, which is 0 for a schema that finished before the first sample.

Every row is exactly what a new user of that library would write.

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
