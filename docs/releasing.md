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
npm run check:handoff
compat/setup.sh && npm run check:compat -- --require-all
python3 scripts/package.py
```

The compatibility check needs Go, a JDK with Maven and the .NET SDK as well. If the compiler's output changed, run it with `--write` and commit the updated [table](../compat/README.md).

The last command uses only Python's standard library. It writes `releases/schema-calc-<version>.zip`, named from `package.json`, and a SHA-256 sidecar. Between releases the version still names the last release, so check packaging with `python3 scripts/package.py --output bench/scratch/package` to keep its published archive intact. The archive contains one versioned root folder and an internal `MANIFEST.sha256` covering every packaged file. It checks local Markdown file links, parses packaged JSON, uses an explicit source allowlist, rejects symlinks, and omits dependency directories, generated corpora, scratch workloads, browser bundles and release archives. Fixed timestamps and file order make the archive reproducible on the same Python/zlib toolchain. This is source packaging, not a substitute for the checks above.

Extract it into an empty directory and run `npm ci`, `npm run demo`, `npm test`, `npm run check:examples`, and `npm run build` there. Run both Python suites against the extracted files as well. Inspect the manifest before publishing. The ZIP is what gets attached to a GitHub release.

## GitHub

The repository is [fMindstormer/schema-calc](https://github.com/fMindstormer/schema-calc). Four workflows run there:

- **Verify schemas** (`.github/workflows/ci.yml`) runs the Node and Python suites, the examples, the build and the browser handoff check on every push and pull request, with read-only permissions.
- **Validator compatibility** (`.github/workflows/compat.yml`) runs every runner in [`compat/`](../compat/README.md) when the compiler, examples or harness change, and fails on any wrong answer.
- **Release links** (`.github/workflows/release-links.yml`) runs `npm run check:releases` on `main`, on pull requests, when a release is published and daily. It fails when a release the README links is missing or a draft, or lacks a file the README downloads from it.
- **Pages** (`.github/workflows/pages.yml`) builds the playground from `main` and publishes `dist/` to [fmindstormer.github.io/schema-calc](https://fmindstormer.github.io/schema-calc/). It needs Settings > Pages > Source set to GitHub Actions once.

The README's download links name the release, so the release commit links a release that does not exist yet, and Release links fails on `main` until it does. Verify the commit on a branch, publish the release from it, and only then move `main` to it. Attach the archive and its checksum, plus the files the README's no-clone instructions download, so they work without the repository:

```sh
v=$(node -p 'require("./package.json").version')
git push origin HEAD:refs/heads/release-$v   # wait for Verify schemas to pass
(cd releases && cp ../examples/invoice.schema.json ../examples/invoice.valid.json ../examples/invoice.invalid.json ../examples/validate.py . \
  && shasum -a 256 schema-calc-$v.zip invoice.schema.json invoice.valid.json invoice.invalid.json validate.py > SHA256SUMS)
git tag v$v && git push origin v$v
gh release create v$v --title "schema-calc v$v" --notes-file releases/notes.md \
  releases/schema-calc-$v.zip releases/schema-calc-$v.zip.sha256 releases/SHA256SUMS \
  releases/invoice.schema.json releases/invoice.valid.json releases/invoice.invalid.json releases/validate.py
npm run check:releases && git push origin HEAD:main && git push origin --delete release-$v
```

`releases/notes.md` is the release description; the folder is ignored by Git. Then run the README's "Reproduce it without cloning" commands in an empty directory.

If the playground's behaviour changed, rerecord the README demonstration with `npm run demo:record` (needs ffmpeg and ImageMagick) and look at `docs/demo.gif` before committing it.

## Before tagging

- Confirm the MIT copyright attribution.
- Run the verification commands and inspect changes to generated examples.
- For compiler changes, rerun the relevant benchmarks and update the tables, methodology and claims together. Preserve slower/negative results when they explain a trade-off.
- Set the version consistently in `package.json`, `package-lock.json` and the playground label; regenerate the archive.
- Keep performance claims scoped to the measured workload. The experimental optimizer is not the default backend, and tally sizes require converted input.

The heavy superoptimizer reproduction is documented in [bench/README.md](../bench/README.md). It is separate from ordinary CI. The package contains its existing results and search certificates; creating an archive does not rerun those experiments.
