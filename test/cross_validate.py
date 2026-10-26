"""Validate the exact exported schemas with the independent Python implementation."""
import json
import time
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

corpus_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("corpus.json")
if not corpus_path.exists():
    raise SystemExit("Run npm test first to generate the corpus.")
corpus = json.loads(corpus_path.read_text())
started = time.perf_counter()
count = 0
for group in corpus:
    Draft202012Validator.check_schema(group["schema"])
    validate = Draft202012Validator(group["schema"])
    for case in group["cases"]:
        actual = validate.is_valid(case["data"])
        if actual != case["expected"]:
            raise AssertionError(f'{group["name"]}: {case["data"]!r}; expected {case["expected"]}, got {actual}')
        count += 1
    print(f'{group["name"]}: {len(group["cases"])} cases passed', flush=True)
print(f'PASS: {count} cases, {len(corpus)} schemas, {time.perf_counter() - started:.2f}s')
