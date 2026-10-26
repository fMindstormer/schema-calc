"""Independent correctness checks. Parallelism is NOT used for timing benchmarks."""
import json
import platform
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from importlib.metadata import version
from pathlib import Path
from jsonschema import Draft202012Validator

root=Path(__file__).parent

def check_group(group):
    Draft202012Validator.check_schema(group['schema'])
    validator=Draft202012Validator(group['schema'])
    for case in group['cases']:
        actual=validator.is_valid(case['data'])
        if actual!=case['expected']:
            raise AssertionError((group['name'],case['data'],case['expected'],actual))
    return group['name'],len(group['cases'])

def main():
    result=json.loads((root/'verification.json').read_text())
    checks={}
    for label,filename in [('full','superoptimizer-corpus.json'),('local','superoptimizer-cells.json')]:
        corpus=json.loads((root/'../../test'/filename).read_text())
        started=time.perf_counter();count=0
        with ProcessPoolExecutor(max_workers=4) as pool:
            futures=[pool.submit(check_group,group) for group in corpus]
            for index,future in enumerate(as_completed(futures)):
                name,passed=future.result();count+=passed
                if label=='full' and ((index+1)%20==0 or passed>=1000):
                    print(f'{label}: {index+1}/{len(corpus)} schemas checked; {name}: {passed} passed',flush=True)
        checks[label]={'cases':count,'schemas':len(corpus),'elapsedSeconds':time.perf_counter()-started,'metaSchemaChecked':True}
        print(f'PASS Python {label}: {count} cases / {len(corpus)} schemas in {checks[label]["elapsedSeconds"]:.2f}s',flush=True)
    result['python']={'version':platform.python_version(),'jsonschema':version('jsonschema'),'correctnessWorkers':4,'checks':checks}
    (root/'verification.json').write_text(json.dumps(result,indent=2)+'\n')

if __name__=='__main__':
    main()
