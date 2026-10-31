# Contributing

Schema Calc is a research compiler with a deliberately small source language. Improvements should preserve its portable output and make their assumptions measurable.

## Development setup

Use Node.js 20 or newer (24 is the reference version) and Python 3.13 for the independent validator. The compiler has no runtime dependencies. Ajv, esbuild and Playwright are pinned in `package-lock.json`; `requirements-test.txt` pins Python jsonschema.

On macOS or Linux:

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm test
npm run check:examples
npm run check:python
npm run check:tally
npm run demo
.venv/bin/python examples/validate.py
npm run build
npx playwright install chromium
npm run check:handoff
npm start
```

On Windows, create the environment with `py -3.13 -m venv .venv`. Replace `.venv/bin/python` with `.venv\Scripts\python`; run the Python checks directly:

```powershell
.venv\Scripts\python -m pip install -r requirements-test.txt
.venv\Scripts\python test/cross_validate.py
.venv\Scripts\python test/cross_validate.py test/tally-corpus.json
```

Run `npm test` before Python checks: it generates the ignored corpora. Run the Python suites sequentially when recording elapsed times. The normal CI workflow performs correctness checks and builds the playground; it does not treat noisy hosted-runner timings as performance gates. CI setup follows GitHub's [Node.js](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs) and [Python](https://docs.github.com/en/actions/tutorials/build-and-test-code/python) guides.

The [validator compatibility](compat/README.md) check is optional locally. It runs the same corpora through validators in JavaScript, Python, Go, Java and C#, and needs those toolchains: `compat/setup.sh`, then `npm run check:compat`. A missing toolchain is skipped and reported.

## Working on the compiler

- State the accepted input domain, including malformed inputs. Domain-dependent regex simplifications must remain justified by the root format checks.
- Explain the identity or invariant behind an arithmetic rewrite. Add independent oracle cases or exhaustive local transition checks where they test that claim.
- Test the actual exported file with both stock validators. Browser preparation is an additional path, not a substitute for this check. A change to emitted keywords, patterns, references or nesting depth should also rerun `npm run check:compat`, since other validators differ in regex dialect and resource handling.
- Preserve reference closure: the output must be self-contained Draft 2020-12, without custom keywords, dynamic input callbacks, or remote dependencies.
- Measure actual UTF-8 JSON size and validation time separately. Keep contracts, precision and record representations identical for a direct comparison; label representation changes explicitly.

The implementation under `src/` is the default. Frozen baselines and experimental compilers live under `bench/`. A smaller experiment is not automatically a replacement. See [bench/README.md](bench/README.md) for evidence and reproduction commands.

After changing the generator, run `npm run examples` and inspect changes to the checked-in schemas. `npm run check:examples` checks for drift without writing files. Do not edit generated examples by hand. Correctness corpora, dependency folders, browser bundles and scratch workloads are generated locally and excluded from Git.

## Reporting a problem

Include the smallest source contract, the exact input JSON, expected and observed results, and the validator/version used. For a performance report, include accepted and rejected workloads, preparation separately from warm validation, and the relevant schema size. Avoid submitting private records; a minimal synthetic example is usually more useful.

Useful research directions include variable ordering, better byte-cost models, per-field bounds and multiplication by decimal constants. Each changes either the compilation search or the proof obligations; proposals should explain both the intended user benefit and the validation strategy.
