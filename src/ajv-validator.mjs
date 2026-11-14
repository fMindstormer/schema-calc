import Ajv2020 from 'ajv/dist/2020.js';
import { schemaResources } from './resources.mjs';
import { locate, formatProblems } from './failures.mjs';

/** Prepare a shared schema graph bottom-up, avoiding deep compiler recursion in WebKit.
 * This only controls Ajv's compilation order; Ajv performs all record validation.
 */
export function prepareValidator(schema) {
  // With listSums: 'positions', a list position is read through a partial prefixItems
  // tuple; Ajv's strict mode refuses those unless strictTuples is off. Other strict
  // checks stay on.
  const ajv = new Ajv2020({ strict: true, strictTuples: false, inlineRefs: false });
  // Tally schemas use a small recursive $defs graph and need no resource packing.
  if (!schema.$id) return withFailures(ajv.compile(schema), ajv, schema);
  const resources = schemaResources(schema);
  // Unbundle only the compiler's in-memory preparation copy. Deeply embedded
  // resources otherwise cause Ajv to regenerate large functions in many contexts.
  // Every replacement is an ordinary reference to the same registered resource.
  function unbundle(value, uri, isRoot = false) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(child => unbundle(child, uri));
    if (!isRoot && value.$id) return { $ref: new URL(value.$id, uri).href };
    return Object.fromEntries(Object.entries(value).map(([key, child]) =>
      [key, key === '$id' ? uri : unbundle(child, uri)]));
  }
  const unbundled = new Map(resources.map(({ uri, schema: resource }) => [uri, unbundle(resource, uri, true)]));
  for (const resource of unbundled.values()) ajv.addSchema(resource);
  for (const { uri } of resources) {
    try { ajv.getSchema(uri); }
    catch (error) { throw new Error(`Preparing ${uri}: ${error.message}`, { cause: error }); }
  }
  return withFailures(ajv.getSchema(schema.$id), ajv, schema, unbundled);
}

/** Give a validator failures(record), which says why a record is rejected: the
 * problems with its format, if any, or else each constraint it fails, with the lines
 * that fail a constraint on each line. Ajv checks the format with a schema of the
 * format alone, and each constraint with its own subschema, on the record or on each
 * line, against the resources already prepared. They are compiled on first use.
 */
function withFailures(validate, ajv, schema, resources) {
  let checks;
  function prepare() {
    const { constraints, format } = locate(schema, resources);
    const formatValidator = new Ajv2020({ strict: true, strictTuples: false, allErrors: true }).compile(format);
    return { format: formatValidator, constraints: constraints.map(({ node, base, ...constraint }, i) => ({ ...constraint,
      validate: !schema.$id ? ajv.compile({ ...node, $defs: schema.$defs })
        : resources.get(base) === node ? ajv.getSchema(base)
        // A sibling name, so that its relative references resolve as before.
        : ajv.compile({ ...node, $id: new URL(`check-${i}`, base).href }) })) };
  }
  validate.failures = record => {
    checks ??= prepare();
    if (!checks.format(record)) return { format: formatProblems(checks.format.errors), constraints: [] };
    const constraints = [];
    for (const { validate: check, list, ...constraint } of checks.constraints) {
      if (list === null) {
        if (!check(record)) constraints.push(constraint);
        continue;
      }
      const items = record[list].flatMap((line, i) => check(line) ? [] : [i]);
      if (items.length) constraints.push({ ...constraint, list, items });
    }
    return { format: [], constraints };
  };
  return validate;
}
