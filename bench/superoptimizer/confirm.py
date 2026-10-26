import json
import statistics
import time
from pathlib import Path
from jsonschema import Draft202012Validator
root=Path(__file__).parent
result=json.loads((root/'confirmation.json').read_text())
cases=json.loads((root/'../scratch/superoptimizer-confirmation.json').read_text())
prepared=[]
for item in cases:
    validator=Draft202012Validator(item['schema'])
    for label,records in item['data'].items():
        for record in records:assert validator.is_valid(record)==(label.startswith('valid'))
    prepared.append((item,validator,{label:[] for label in item['data']}))
for round_number in range(3):
    for i in range(len(prepared)):
        item,validator,samples=prepared[(i+round_number)%len(prepared)]
        for label,records in item['data'].items():
            repeats=512 if label=='malformed' else 32 if label.endswith('Example') else 1
            start=time.perf_counter();accepted=0
            for _ in range(repeats):
                accepted+=sum(validator.is_valid(record) for record in records)
            assert accepted==(len(records)*repeats if label.startswith('valid') else 0)
            samples[label].append((time.perf_counter()-start)*1000/(len(records)*repeats))
    print(f'Confirmation Python round {round_number+1}/3 complete',flush=True)
for item,validator,samples in prepared:
    row=next(r for r in result['rows'] if (r['name'],r['implementation'],r['seed'])==(item['name'],item['implementation'],item['seed']))
    row['python']={label:{'medianMs':statistics.median(values),'samplesMs':values} for label,values in samples.items()}
result['pythonMethodology']='Same unmodified validator and class checks; 3 rotating rounds per new seed. Each broad valid/invalid round traverses all 32 records; each original example is repeated 32 times; malformed rounds repeat the 8 records 512 times to stabilize their much shorter timings.'
result['gates']=[]
for name in ['invoice','allocation','carry']:
    for baseline_name in ['production','prior-pair']:
        subset=[r for r in result['rows'] if r['name']==name]
        if not any(r['implementation']==baseline_name for r in subset):continue
        for candidate in sorted({r['implementation'] for r in subset if r['implementation'] not in ['production','prior-pair']}):
            comparisons=[]
            for row in [r for r in subset if r['implementation']==candidate]:
                baseline=next(r for r in subset if r['implementation']==baseline_name and r['seed']==row['seed'])
                ratios={f'{engine}/{label}':row[engine][label]['medianMs']/baseline[engine][label]['medianMs'] for engine in ['ajv','python'] for label in row['python']}
                comparisons.append({'seed':row['seed'],'ratios':ratios})
            all_ratios=[v for c in comparisons for v in c['ratios'].values()]
            result['gates'].append({'name':name,'candidate':candidate,'baseline':baseline_name,'comparisons':comparisons,
                                   'allMediansNoHigher':all(r<=1 for r in all_ratios),'withinFivePercent':all(r<=1.05 for r in all_ratios)})
(root/'confirmation.json').write_text(json.dumps(result,indent=2)+'\n')
for gate in result['gates']:print(gate['name'],gate['candidate'],'vs',gate['baseline'],gate['allMediansNoHigher'],gate['withinFivePercent'],flush=True)
