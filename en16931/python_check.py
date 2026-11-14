"""Validate JSON invoices, one per line on stdin, against a schema with stock
Python jsonschema and its default options, including the default recursion limit.
Prints a JSON line with versions, then one per invoice with its verdict and time;
the verdict is null if validation exceeded the recursion limit. For a rejected
invoice it adds the rules examples/validate.py finds broken, untimed.
"""
import importlib.util
import json
import sys
import time
from importlib.metadata import version
from pathlib import Path

from jsonschema import Draft202012Validator

spec = importlib.util.spec_from_file_location("validate", Path(__file__).resolve().parent.parent / "examples" / "validate.py")
validate_py = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validate_py)

validator = Draft202012Validator(json.load(open(sys.argv[1])))
print(json.dumps({'jsonschema': version('jsonschema'), 'python': sys.version.split()[0], 'recursionLimit': sys.getrecursionlimit()}), flush=True)
for line in sys.stdin:
    if line.strip():
        record = json.loads(line)
        start = time.perf_counter()
        try:
            valid = validator.is_valid(record)
        except RecursionError:
            valid = None
        result = {'valid': valid, 'ms': (time.perf_counter() - start) * 1000}
        if valid is False:
            try:
                problems, constraints = validate_py.failures(validator, record)
                result['failed'] = {'format': bool(problems), 'constraints': [name for name, *_ in constraints]}
            except RecursionError:
                result['failed'] = None
        print(json.dumps(result), flush=True)
