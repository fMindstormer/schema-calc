"""Validate the exported file without importing or running the compiler."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).parent
schema = json.loads((root / "invoice.schema.json").read_text(encoding="utf-8"))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
for name, expected in [("invoice.valid.json", True), ("invoice.invalid.json", False)]:
    record = json.loads((root / name).read_text(encoding="utf-8"))
    accepted = validator.is_valid(record)
    if accepted != expected:
        raise AssertionError(name)
    print(f"{'ACCEPT' if accepted else 'REJECT'}  total={record['total']}  ({name})")
