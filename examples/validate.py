"""Validate exported Schema Calc files with stock jsonschema, without the compiler.

    python3 validate.py SCHEMA RECORD [RECORD ...]

Prints ACCEPT or REJECT for each record. Exits 0 when every record is accepted,
1 when any is rejected. Without arguments, checks the invoice examples beside
this file. Requires only jsonschema (tested with 4.25.1).
"""
import argparse
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validator_for(path):
    schema = load(path)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def check_examples():
    root = Path(__file__).parent
    validator = validator_for(root / "invoice.schema.json")
    for name, expected in [("invoice.valid.json", True), ("invoice.invalid.json", False)]:
        record = load(root / name)
        accepted = validator.is_valid(record)
        if accepted != expected:
            raise AssertionError(name)
        print(f"{'ACCEPT' if accepted else 'REJECT'}  total={record['total']}  ({name})")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("schema", nargs="?", help="exported .schema.json file")
    parser.add_argument("records", nargs="*", help="record JSON files to validate")
    args = parser.parse_args()
    if args.schema is None:
        check_examples()
        return 0
    if not args.records:
        parser.error("give at least one record file after the schema")
    validator = validator_for(args.schema)
    accepted_all = True
    for path in args.records:
        accepted = validator.is_valid(load(path))
        accepted_all &= accepted
        print(f"{'ACCEPT' if accepted else 'REJECT'}  {Path(path).name}")
    return 0 if accepted_all else 1


if __name__ == "__main__":
    sys.exit(main())
