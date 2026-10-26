import Ajv2020 from 'ajv/dist/2020.js';
import { schemaResources } from './resources.mjs';

/** Prepare a shared schema graph bottom-up, avoiding deep compiler recursion in WebKit.
 * This only controls Ajv's compilation order; Ajv performs all record validation.
 */
export function prepareValidator(schema) {
  const ajv = new Ajv2020({ strict: true, inlineRefs: false });
  // Tally schemas use a small recursive $defs graph and need no resource packing.
  if (!schema.$id) return ajv.compile(schema);
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
  for (const resource of resources) {
    ajv.addSchema(unbundle(resource.schema, resource.uri, true));
  }
  for (const { uri } of resources) {
    try { ajv.getSchema(uri); }
    catch (error) { throw new Error(`Preparing ${uri}: ${error.message}`, { cause: error }); }
  }
  return ajv.getSchema(schema.$id);
}
