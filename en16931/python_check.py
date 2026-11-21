"""Validate JSON invoices, one per line on stdin, against a schema with stock
Python jsonschema and its default options, including the default recursion limit,
and with the validator examples/validate.py builds, which crawls the schema's
resources once. Prints a JSON line with versions and how long validate.py took to
set up, then one per invoice with each verdict and time; a verdict is null if
validation exceeded the recursion limit. For a rejected invoice it adds the rules
validate.py finds broken, untimed.
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

stock = Draft202012Validator(json.load(open(sys.argv[1])))
start = time.perf_counter()
validator = validate_py.validator_for(sys.argv[1])
setup_ms = (time.perf_counter() - start) * 1000
print(json.dumps({'jsonschema': version('jsonschema'), 'python': sys.version.split()[0], 'recursionLimit': sys.getrecursionlimit(), 'validatePySetupMs': setup_ms}), flush=True)


def timed(v, record):
    start = time.perf_counter()
    try:
        valid = v.is_valid(record)
    except RecursionError:
        valid = None
    return valid, (time.perf_counter() - start) * 1000


for line in sys.stdin:
    if line.strip():
        record = json.loads(line)
        valid, ms = timed(stock, record)
        fast_valid, fast_ms = timed(validator, record)
        result = {'valid': valid, 'ms': ms, 'validatePyValid': fast_valid, 'validatePyMs': fast_ms}
        if fast_valid is False:
            try:
                problems, constraints = validate_py.failures(validator, record)
                result['failed'] = {'format': bool(problems), 'constraints': [name for name, *_ in constraints]}
            except RecursionError:
                result['failed'] = None
        print(json.dumps(result), flush=True)
