"""Validate exported Schema Calc files with stock jsonschema, without the compiler.

    python3 validate.py SCHEMA RECORD [RECORD ...]

Prints ACCEPT or REJECT for each record, and under REJECT, why: the record's
format problems, if any, or else each constraint it fails. Exits 0 when every
record is accepted, 1 when any is rejected. Without arguments, checks the invoice
examples beside this file. Requires only jsonschema (tested with 4.25.1).
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


def failures(validator, record):
    """Why the validator rejects a record, from jsonschema's errors alone.

    The compiler marks each constraint's subschema with its source in $comment and
    its name, if it has one, in title: in the allOf of the schema's body for a
    constraint on the record, and in the allOf of a list's items for one on each
    line. Everything else checks the record's format. A subschema may have moved
    to root $defs, leaving a reference that is its only keyword. Returns
    (problems, constraints): format problems as (problem, JSON Pointer), sorted;
    if there are none, each failing constraint as (name, source, list, items).
    """
    schema = validator.schema
    ids = {}

    def index(node):
        if isinstance(node, dict):
            if isinstance(node.get("$id"), str) and node is not schema:
                ids[node["$id"]] = node
            for child in node.values():
                index(child)
        elif isinstance(node, list):
            for child in node:
                index(child)

    index(schema)

    def resolve(ref):
        if not ref.startswith("#/"):
            return ids[ref]
        node = schema
        for part in ref[2:].split("/"):
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node

    def follow(node):
        while isinstance(node, dict) and list(node) == ["$ref"]:
            node = resolve(node["$ref"])
        return node

    def marked(node):
        return isinstance(node, dict) and isinstance(node.get("$comment"), str)

    body = schema
    if "$ref" in body and "allOf" not in body and "properties" not in body:
        body = resolve(body["$ref"])
    constraints = [(node, None) for node in map(follow, body.get("allOf", [])) if marked(node)]
    for name, prop in body.get("properties", {}).items():
        items = follow(prop).get("items") if isinstance(follow(prop), dict) else None
        if isinstance(items, dict):
            constraints += [(node, name) for node in map(follow, follow(items).get("allOf", [])) if marked(node)]

    def constraint_of(error):
        # jsonschema leaves $ref, and if, out of an error's schema path.
        node = body
        for key in error.relative_schema_path:
            node = follow(node)
            if marked(node):
                return node
            try:
                node = node[key]
            except (KeyError, IndexError, TypeError):
                return None
        node = follow(node)
        return node if marked(node) else None

    def escape(name):
        return str(name).replace("~", "~0").replace("/", "~1")

    problems, failed = set(), {}
    for error in validator.iter_errors(record):
        node = constraint_of(error)
        at = "".join(f"/{escape(key)}" for key in error.absolute_path)
        if node is not None:
            lines = failed.setdefault(id(node), set())
            if len(error.absolute_path) >= 2:
                lines.add(error.absolute_path[1])
        elif error.validator == "required":
            problems.update(("missing", f"{at}/{escape(name)}") for name in error.validator_value if name not in error.instance)
        elif error.validator == "additionalProperties":
            known = error.schema.get("properties", {})
            problems.update(("unexpected", f"{at}/{escape(name)}") for name in error.instance if name not in known)
        else:
            problems.add(("invalid", at))
    if problems:
        return sorted(problems, key=lambda p: (p[1], p[0])), []
    return [], [(node.get("title"), node["$comment"], name, sorted(failed[id(node)]) if name else [])
                for node, name in constraints if id(node) in failed]


def describe(problems, constraints):
    """The lines printed under REJECT, as the playground shows them."""
    if problems:
        return [f"  {problem}: {at or 'the record'}" for problem, at in problems]
    if not constraints:
        return ["  no constraint or format check fails on its own"]
    return [f"  fails{' ' + name if name else ''}: {source}"
            + (f" at {', '.join(f'/{lst}/{i}' for i in items)}" if lst else "")
            for name, source, lst, items in constraints]


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
        record = load(path)
        accepted = validator.is_valid(record)
        accepted_all &= accepted
        print(f"{'ACCEPT' if accepted else 'REJECT'}  {Path(path).name}")
        if not accepted:
            print("\n".join(describe(*failures(validator, record))))
    return 0 if accepted_all else 1


if __name__ == "__main__":
    sys.exit(main())
