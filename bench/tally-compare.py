"""Run after tally-compare.mjs; timing excludes schema checks and record conversion."""
import json
import platform
import statistics
import time
from pathlib import Path
from importlib.metadata import version
from jsonschema import Draft202012Validator

root = Path(__file__).parent
result = json.loads((root / 'tally-results.json').read_text())
for case in json.loads((root / 'scratch/tally-benchmark-cases.json').read_text()):
    Draft202012Validator.check_schema(case['schema'])
    validator = Draft202012Validator(case['schema'])
    row = next(r for r in result['rows'] if r['name'] == case['name'] and r['implementation'] == case['implementation'])
    for label, expected in [('valid', True), ('invalid', False)]:
        data = case[label]
        for _ in range(5):
            assert validator.is_valid(data) == expected
        timings = []
        for _ in range(5):
            start = time.perf_counter()
            for _ in range(20):
                assert validator.is_valid(data) == expected
            timings.append((time.perf_counter() - start) * 1000 / 20)
        row[f'python{label.title()}Ms'] = statistics.median(timings)
    print(case['name'], case['implementation'], row['pythonValidMs'], row['pythonInvalidMs'], flush=True)
result['python'] = platform.python_version()
result['jsonschema'] = version('jsonschema')
result['pythonMethodology'] = 'Stock Draft202012Validator.is_valid. Median of 5 batches of 20 after 5 warmups; input already encoded; schema meta-validation outside timing.'
(root / 'tally-results.json').write_text(json.dumps(result, indent=2) + '\n')
