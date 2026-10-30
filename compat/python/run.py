"""Runs one Python validator over a corpus with its default options and prints the
shared result format (see compat/README.md). Usage: python run.py <validator> <corpus.json> [first group]"""
import json
import sys
import time
from importlib.metadata import version


def jsonschema_validator():
    from jsonschema import Draft202012Validator
    return "jsonschema", lambda schema: Draft202012Validator(schema).is_valid


def jsonschema_rs_validator():
    import jsonschema_rs
    return "jsonschema-rs", lambda schema: jsonschema_rs.Draft202012Validator(schema).is_valid


VALIDATORS = {"jsonschema": jsonschema_validator, "jsonschema-rs": jsonschema_rs_validator}

if len(sys.argv) not in (3, 4) or sys.argv[1] not in VALIDATORS:
    raise SystemExit(f"usage: python run.py <{'|'.join(VALIDATORS)}> <corpus.json> [first group]")
package, prepare = VALIDATORS[sys.argv[1]]()
with open(sys.argv[2], encoding="utf-8") as file:
    corpus = json.load(file)
print(json.dumps({"validator": package, "version": version(package), "language": "Python",
                  "runtime": f"Python {sys.version.split()[0]}"}), flush=True)
for index in range(int(sys.argv[3]) if len(sys.argv) == 4 else 0, len(corpus)):
    group = corpus[index]
    result = {"index": index, "name": group["name"], "cases": len(group["cases"]), "falseAccepts": 0,
              "falseRejects": 0, "caseErrors": 0, "caseError": None, "error": None}
    started = time.perf_counter()
    try:
        check = prepare(group["schema"])
        result["loadSeconds"] = time.perf_counter() - started
        print(json.dumps({"heartbeat": index, "done": 0}), flush=True)
        for done, case in enumerate(group["cases"]):
            if done and done % 100 == 0:
                print(json.dumps({"heartbeat": index, "done": done}), flush=True)
            try:
                actual = check(case["data"])
            except Exception as error:
                result["caseErrors"] += 1
                result["caseError"] = result["caseError"] or str(error)[:300]
                continue
            result["falseAccepts"] += actual and not case["expected"]
            result["falseRejects"] += case["expected"] and not actual
    except Exception as error:  # Report the validator's refusal instead of stopping.
        result["error"] = str(error)[:300]
    print(json.dumps({**result, "seconds": time.perf_counter() - started}), flush=True)
