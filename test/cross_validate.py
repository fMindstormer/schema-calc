"""Validate the exact exported schemas with the independent Python implementation.

For an evenly spaced sample of each schema's rejected records, also check that
examples/validate.py explains the rejection as Ajv's report, written by npm test,
does: the same format problems, or the same failing constraints and lines.
"""
import importlib.util
import json
import time
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

REPORTS_PER_SCHEMA = 200
spec = importlib.util.spec_from_file_location("validate", Path(__file__).resolve().parent.parent / "examples" / "validate.py")
validate_py = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate_py)

corpus_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("corpus.json")
if not corpus_path.exists():
    raise SystemExit("Run npm test first to generate the corpus.")
corpus = json.loads(corpus_path.read_text())
started = time.perf_counter()
count = reports = 0
for group in corpus:
    Draft202012Validator.check_schema(group["schema"])
    validate = Draft202012Validator(group["schema"])
    for case in group["cases"]:
        actual = validate.is_valid(case["data"])
        if actual != case["expected"]:
            raise AssertionError(f'{group["name"]}: {case["data"]!r}; expected {case["expected"]}, got {actual}')
        count += 1
    rejected = [case for case in group["cases"] if not case["expected"]]
    step = max(1, -(-len(rejected) // REPORTS_PER_SCHEMA))
    for case in rejected[::step]:
        if "failures" not in case:
            raise SystemExit("Run npm test again: the corpus has no failure reports.")
        actual = validate_py.describe(*validate_py.failures(validate, case["data"]))
        if actual != case["failures"]:
            raise AssertionError(f'{group["name"]}: {case["data"]!r}; Ajv reports {case["failures"]}, validate.py {actual}')
        reports += 1
    print(f'{group["name"]}: {len(group["cases"])} cases passed', flush=True)
print(f'PASS: {count} cases, {reports} reports, {len(corpus)} schemas, {time.perf_counter() - started:.2f}s')
