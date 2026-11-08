"""Validate JSON invoices, one per line on stdin, against a schema with stock
Python jsonschema and its default options, including the default recursion limit.
Prints a JSON line with versions, then one per invoice with its verdict and time;
the verdict is null if validation exceeded the recursion limit.
"""
import json
import sys
import time
from importlib.metadata import version

from jsonschema import Draft202012Validator

validator = Draft202012Validator(json.load(open(sys.argv[1])))
print(json.dumps({'jsonschema': version('jsonschema'), 'python': sys.version.split()[0], 'recursionLimit': sys.getrecursionlimit()}), flush=True)
for line in sys.stdin:
    if line.strip():
        start = time.perf_counter()
        try:
            valid = validator.is_valid(json.loads(line))
        except RecursionError:
            valid = None
        print(json.dumps({'valid': valid, 'ms': (time.perf_counter() - start) * 1000}), flush=True)
