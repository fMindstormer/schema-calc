"""Create an auditable source ZIP without Git or third-party Python packages."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
TOP_LEVEL = (
    ".gitignore", ".gitattributes", ".nvmrc", "LICENSE", "README.md",
    "CONTRIBUTING.md", "package.json", "package-lock.json", "requirements-test.txt",
)
SOURCE_DIRS = {
    "src": {".mjs"}, "bin": {".mjs"}, "scripts": {".mjs", ".py", ".html"},
    "web": {".mjs", ".html", ".css"},
    "examples": {".json", ".mjs", ".py"}, "test": {".mjs", ".py"},
    "bench": {".mjs", ".py", ".json", ".md"},
    "docs": {".md", ".svg", ".png", ".gif"}, ".github": {".yml", ".yaml", ".md"},
}


def source_files():
    paths = [ROOT / name for name in TOP_LEVEL]
    for directory, extensions in SOURCE_DIRS.items():
        base = ROOT / directory
        if base.is_symlink():
            raise ValueError(f"Refusing source-directory symlink: {directory}")
        if not base.exists():
            if directory == "docs":
                continue
            raise FileNotFoundError(base)
        for path in base.rglob("*"):
            relative = path.relative_to(ROOT)
            if "scratch" in relative.parts or "__pycache__" in relative.parts:
                continue
            if path.is_symlink():
                raise ValueError(f"Refusing symlink: {relative}")
            if path.is_file() and path.suffix in extensions:
                paths.append(path)
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing source file or symlink: {path.relative_to(ROOT)}")
    return sorted(paths, key=lambda path: path.relative_to(ROOT).as_posix())


def check_contents(files):
    included = set(files)
    for path in files:
        if path.suffix == ".json":
            json.loads(path.read_text(encoding="utf-8"))
        if path.suffix != ".md":
            continue
        # These docs use inline Markdown links; fragment anchors are left to GitHub.
        for target in re.findall(r"\]\(([^\s)]+)\)", path.read_text(encoding="utf-8")):
            url = urlsplit(target.strip("<>"))
            if url.scheme or url.netloc or not url.path:
                continue
            resolved = (path.parent / unquote(url.path)).resolve()
            if resolved not in included and not any(resolved in file.parents for file in files):
                raise ValueError(f"Unpackaged Markdown link in {path.relative_to(ROOT)}: {target}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "releases", help="Output directory")
    args = parser.parse_args()
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    stem = f"{package['name']}-{package['version']}"
    if not re.fullmatch(r"[a-zA-Z0-9._-]+", stem):
        raise ValueError("Package name/version must be safe archive path components")
    files = source_files()
    check_contents(files)
    entries = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in files}
    manifest = "".join(f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in entries.items())
    entries["MANIFEST.sha256"] = manifest.encode("utf-8")
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / f"{stem}.zip"
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries.items():
            info = ZipInfo(f"{stem}/{name}", date_time=(2000, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name.startswith("bin/") else 0o100644) << 16
            archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(".zip.sha256").write_text(f"{digest}  {destination.name}\n", encoding="utf-8")
    print(f"Packaged {len(files)} source files ({sum(map(len, entries.values())):,} bytes uncompressed)")
    print(f"{destination}: {destination.stat().st_size:,} bytes")
    print(f"SHA-256: {digest}")


if __name__ == "__main__":
    main()
