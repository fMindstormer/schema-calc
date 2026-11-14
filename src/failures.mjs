// Which constraint does a rejected record fail? The compiler marks each constraint's
// subschema with its source in $comment and its name, if the contract gives one, in
// title: in the body's allOf for a constraint on the record, and in the allOf of a
// list's items for a constraint on each line. Everything else in the schema checks the
// record's format: its fields, their spelling and the lists' lengths. The resource
// packer may move any of these subschemas into root $defs, leaving a bare reference.

const SUBSCHEMA = new Set(['items', 'not', 'if', 'then', 'else', 'contains', 'additionalProperties']);
const SUBSCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
// Identity and annotations, which a schema of the format alone does not need.
const DROPPED = new Set(['$id', '$defs', '$schema', '$comment', 'title']);

const isSchema = node => node !== null && typeof node === 'object' && !Array.isArray(node);
const bare = node => isSchema(node) && Object.keys(node).length === 1 && typeof node.$ref === 'string';
const isConstraint = node => isSchema(node) && typeof node.$comment === 'string';
const pointer = (node, path) => path.split('/').slice(1).map(part => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'))
  .reduce((value, key) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Unresolved pointer: ${path}`);
    return value[key];
  }, node);

/** Find a compiled schema's constraints and build a schema of its format alone.
 * resources maps each resource's URI to its schema, with no resource embedded in
 * another (as prepareValidator registers them); a document without $id, such as a
 * tally schema, refers only within itself with #/ pointers.
 * Returns constraints in document order, each { node, base, list, source, name },
 * and format, a self-contained schema without references.
 */
export function locate(schema, resources) {
  function resolve(ref, base) {
    if (!schema.$id) {
      if (!ref.startsWith('#/')) throw new Error(`Unresolved reference: ${ref}`);
      return { node: pointer(schema, ref.slice(1)), base };
    }
    const url = new URL(ref, base), fragment = url.hash;
    url.hash = '';
    if (!resources.has(url.href)) throw new Error(`Unresolved reference: ${ref}`);
    const document = resources.get(url.href);
    return { node: fragment.length > 1 ? pointer(document, fragment.slice(1)) : document, base: url.href };
  }
  const follow = (node, base) => {
    while (bare(node)) ({ node, base } = resolve(node.$ref, base));
    return { node, base };
  };
  let body = { node: schema.$id ? resources.get(schema.$id) : schema, base: schema.$id };
  if (!body.node) throw new Error('The schema is not among its resources.');
  if (typeof body.node.$ref === 'string' && !body.node.allOf && !body.node.properties) body = resolve(body.node.$ref, body.base);

  const constraints = [];
  const collect = ({ node, base }, list) => {
    for (const entry of node.allOf ?? []) {
      const found = follow(entry, base);
      if (isConstraint(found.node)) constraints.push({ ...found, list, source: found.node.$comment, ...(typeof found.node.title === 'string' && { name: found.node.title }) });
    }
  };
  collect(body, null);
  for (const [name, property] of Object.entries(body.node.properties ?? {})) {
    const list = follow(property, body.base);
    if (isSchema(list.node) && isSchema(list.node.items)) collect(follow(list.node.items, list.base), name);
  }

  // The format is the schema without its constraints, with every reference replaced by
  // what it refers to: the format's subschemas form a small tree.
  function strip(node, base) {
    if (!isSchema(node)) return node;
    const result = {}, conjuncts = [];
    for (const [key, value] of Object.entries(node)) {
      if (DROPPED.has(key)) continue;
      if (key === '$ref') {
        const target = resolve(value, base);
        conjuncts.push(strip(target.node, target.base));
      } else if (key === 'allOf') {
        for (const entry of value) if (!isConstraint(follow(entry, base).node)) conjuncts.push(strip(entry, base));
      } else if (SUBSCHEMA_LISTS.has(key)) result[key] = value.map(entry => strip(entry, base));
      else if (key === 'properties') result[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, strip(entry, base)]));
      else if (SUBSCHEMA.has(key)) result[key] = strip(value, base);
      else result[key] = value;
    }
    if (conjuncts.length) result.allOf = conjuncts;
    return result;
  }
  return { constraints, format: strip(body.node, body.base) };
}

const escape = name => name.replace(/~/g, '~0').replace(/\//g, '~1');
const order = (a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.problem < b.problem ? -1 : a.problem > b.problem ? 1 : 0;

/** Ajv's errors against the format schema, as the problems a report lists: a missing
 * or unexpected property, or an invalid value, each at its JSON Pointer. */
export function formatProblems(errors) {
  const problems = new Map();
  // When contains fails, Ajv keeps an error for each item that did not match, which is
  // no fault of that item: the failure is the count, an error at the array.
  for (const error of (errors ?? []).filter(e => !e.schemaPath.includes('/contains/'))) {
    const problem = error.keyword === 'required' ? { problem: 'missing', at: `${error.instancePath}/${escape(error.params.missingProperty)}` }
      : error.keyword === 'additionalProperties' ? { problem: 'unexpected', at: `${error.instancePath}/${escape(error.params.additionalProperty)}` }
      : { problem: 'invalid', at: error.instancePath };
    problems.set(`${problem.problem} ${problem.at}`, problem);
  }
  return [...problems.values()].sort(order);
}

/** The lines a report prints under REJECT, as examples/validate.py prints them. */
export function describeFailures({ format, constraints }) {
  if (format.length) return format.map(({ problem, at }) => `  ${problem}: ${at || 'the record'}`);
  if (!constraints.length) return ['  no constraint or format check fails on its own'];
  return constraints.map(({ name, source, list, items }) =>
    `  fails${name ? ` ${name}` : ''}: ${source}${list ? ` at ${items.map(i => `/${escape(list)}/${i}`).join(', ')}` : ''}`);
}
