"""Independent validation and held-out timing; no plugin, converter or resolver helper."""
import json
import platform
import statistics
import time
from pathlib import Path
from importlib.metadata import version
from jsonschema import Draft202012Validator

root=Path(__file__).parent
result=json.loads((root/'results.json').read_text())
cases=json.loads((root/'../scratch/superoptimizer-benchmark.json').read_text())
prepared=[]
for case in cases:
    Draft202012Validator.check_schema(case['schema'])
    started=time.perf_counter()
    validator=Draft202012Validator(case['schema'])
    validator.is_valid(case['data']['valid'][0])
    prepare_ms=(time.perf_counter()-started)*1000
    for label, records in case['data'].items():
        for record in records:
            assert validator.is_valid(record)==(label=='valid'), (case['name'],case['implementation'],label,record)
    prepared.append((case,validator,{'valid':[],'invalid':[],'malformed':[]},prepare_ms))
print(f'All {len(prepared)} schemas and held-out records checked; starting Python timing.',flush=True)
for round_number in range(7):
    for i in range(len(prepared)):
        case,validator,samples,_=prepared[(i+round_number)%len(prepared)]
        for label,records in case['data'].items():
            started=time.perf_counter()
            accepted=sum(validator.is_valid(record) for record in records)
            assert accepted==(len(records) if label=='valid' else 0)
            samples[label].append((time.perf_counter()-started)*1000/len(records))
    print(f'Python timing round {round_number+1}/7 complete',flush=True)
for case,validator,samples,prepare_ms in prepared:
    row=next(r for r in result['rows'] if r['name']==case['name'] and r['implementation']==case['implementation'])
    row['python']={label:{'medianMs':statistics.median(values),'samplesMs':values} for label,values in samples.items()}
    row['pythonConstructAndFirstValidMs']=prepare_ms
    print(row['name'],row['implementation'],*[round(row['python'][label]['medianMs'],4) for label in samples],flush=True)
result['pythonVersion']=platform.python_version()
result['jsonschemaVersion']=version('jsonschema')
result['pythonMethodology']='Unmodified Draft202012Validator.is_valid. Same 32 accepted, 32 arithmetic errors and 8 malformed flat records as Ajv. Full workload warmup/check, followed by 7 rotating rounds over each workload. Median milliseconds/record. Schema meta-validation excluded; constructor plus first accepted validation reported separately.'
(root/'results.json').write_text(json.dumps(result,indent=2)+'\n')
