#!/bin/sh
# Installs the pinned validators for `npm run check:compat` under bench/scratch/compat.
# A toolchain that is not installed is skipped; the harness then reports its runner as not run.
set -eu
cd "$(dirname "$0")/.."
out=bench/scratch/compat
mkdir -p "$out"
have() { command -v "$1" >/dev/null 2>&1 || { echo "skip: $1 not found" >&2; return 1; }; }

npm ci --prefix compat/js --no-audit --no-fund
if have "${PYTHON:-python3}"; then
  "${PYTHON:-python3}" -m venv "$out/venv"
  "$out/venv/bin/python" -m pip install -q --disable-pip-version-check -r compat/python/requirements.txt
fi
if have go; then (cd compat/go && go build -o "../../$out/compat-go" .); fi
if have mvn; then
  (cd compat/java && mvn -q -B compile dependency:build-classpath "-Dmdep.outputFile=../../$out/java-classpath.txt")
fi
if have dotnet; then dotnet build compat/dotnet -c Release -o "$out/dotnet" --nologo -v q; fi
