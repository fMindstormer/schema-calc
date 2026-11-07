#!/bin/sh
# Download the official EN 16931 validation artefacts at a fixed release, and
# Saxon-HE to run their Schematron, into bench/scratch/en16931. The artefacts are
# licensed under the EUPL 1.2 and are not copied into this repository.
set -eu
cd "$(dirname "$0")/.."
out=bench/scratch/en16931
tag=validation-1.3.17
mkdir -p "$out/saxon"
if [ ! -d "$out/artefacts" ]; then
  git clone -q --depth 1 --branch "$tag" https://github.com/ConnectingEurope/eInvoicing-EN16931.git "$out/artefacts"
fi
for jar in net/sf/saxon/Saxon-HE/12.5/Saxon-HE-12.5.jar org/xmlresolver/xmlresolver/5.2.2/xmlresolver-5.2.2.jar \
  org/xmlresolver/xmlresolver/5.2.2/xmlresolver-5.2.2-data.jar; do
  file="$out/saxon/$(basename "$jar")"
  [ -f "$file" ] || curl -fsSL "https://repo1.maven.org/maven2/$jar" -o "$file"
  echo "$(curl -fsSL "https://repo1.maven.org/maven2/$jar.sha1")  $file" | shasum -a 1 -c - >/dev/null
done
echo "EN 16931 artefacts $tag and Saxon-HE 12.5 are in $out"
