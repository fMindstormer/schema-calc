# Preparing a public release

The repository includes the MIT license, source, playground, runnable examples, frozen compiler baselines, research reports, measurement files and CI configuration. GitHub hosting and npm publication are separate: `private: true` in `package.json` prevents accidental npm publication and does not prevent a public GitHub repository.

## Verify and package

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) to install dependencies, then run:

```sh
npm test
npm run check:examples
npm run check:python
npm run check:tally
npm run demo
.venv/bin/python examples/validate.py
npm run build
python3 scripts/package.py
```

The last command uses only Python's standard library. It writes `releases/schema-calc-0.1.0.zip` and a SHA-256 sidecar. The archive contains one versioned root folder and an internal `MANIFEST.sha256` covering every packaged file. It checks local Markdown file links, parses packaged JSON, uses an explicit source allowlist, rejects symlinks, and omits dependency directories, generated corpora, scratch workloads, browser bundles and release archives. Fixed timestamps and file order make the archive reproducible on the same Python/zlib toolchain. This is source packaging, not a substitute for the checks above.

Extract it into an empty directory and run `npm ci`, `npm run demo`, `npm test`, `npm run check:examples`, and `npm run build` there. Run both Python suites against the extracted files as well. Inspect the manifest before publishing. The ZIP is what gets attached to a GitHub release.

## GitHub

The repository is [fMindstormer/schema-calc](https://github.com/fMindstormer/schema-calc). Two workflows run there:

- **Verify schemas** (`.github/workflows/ci.yml`) runs the Node and Python suites, the examples and the build on every push and pull request, with read-only permissions.
- **Pages** (`.github/workflows/pages.yml`) builds the playground from `main` and publishes `dist/` to [fmindstormer.github.io/schema-calc](https://fmindstormer.github.io/schema-calc/). It needs Settings > Pages > Source set to GitHub Actions once.

To release, tag the verified commit and attach the archive and its checksum:

```sh
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 releases/schema-calc-0.1.0.zip releases/schema-calc-0.1.0.zip.sha256
```

## Before tagging

- Confirm the MIT copyright attribution.
- Run the verification commands and inspect changes to generated examples.
- For compiler changes, rerun the relevant benchmarks and update the tables, methodology and claims together. Preserve slower/negative results when they explain a trade-off.
- Set the version consistently in `package.json`, `package-lock.json` and the playground label; regenerate the archive.
- Keep performance claims scoped to the measured workload. The experimental optimizer is not the default backend, and tally sizes require converted input.

The heavy superoptimizer reproduction is documented in [bench/README.md](../bench/README.md). It is separate from ordinary CI. The package contains its existing results and search certificates; creating an archive does not rerun those experiments.
