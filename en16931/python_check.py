"""Validate JSON invoices, one per line on stdin, against a schema with stock
Python jsonschema. The schema's decision paths nest deeper than Python's default
recursion limit of 1,000, so this raises it; no other option changes. Prints a
JSON line with versions, then one per invoice with its verdict and time.
"""
import json
import sys
import time
from importlib.metadata import version

from jsonschema import Draft202012Validator

sys.setrecursionlimit(100_000)
validator = Draft202012Validator(json.load(open(sys.argv[1])))
print(json.dumps({'jsonschema': version('jsonschema'), 'python': sys.version.split()[0], 'recursionLimit': sys.getrecursionlimit()}), flush=True)
for line in sys.stdin:
    if line.strip():
        start = time.perf_counter()
        valid = validator.is_valid(json.loads(line))
        print(json.dumps({'valid': valid, 'ms': (time.perf_counter() - start) * 1000}), flush=True)
