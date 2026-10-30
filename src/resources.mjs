// System.Text.Json, which JsonSchema.Net parses with, reads 64 levels by default, and
// networknt's loading time grows steeply with nesting: at 56 levels the invoice
// does not load within two minutes, while at 32 the whole corpus loads in seconds.
export const MAX_DEPTH = 32;
const SUBSCHEMA = new Set(['if', 'then', 'else', 'not']);
const SUBSCHEMA_MAPS = new Set(['allOf', 'properties']);

function label(n) {
  let key = '';
  do {
    key = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 52] + key;
    n = Math.floor(n / 52) - 1;
  } while (n >= 0);
  return key;
}
function height(value) {
  if (!value || typeof value !== 'object') return 0;
  return 1 + Math.max(0, ...Object.values(value).map(height));
}

/** Pack a static $defs graph as a self-contained compound schema document.
 * By default a shared node is declared at its first use; later uses refer to its
 * short $id. The 'defs' layout declares every shared node in root $defs instead,
 * so no resource sits inside another. Either way, subschemas that would nest
 * deeper than maxDepth JSON levels move to root $defs.
 * The reserved .invalid origin identifies bundled resources, not network files.
 */
export function packResources(graph, { maxDepth = MAX_DEPTH, layout = 'embedded' } = {}) {
  if (!['embedded', 'defs'].includes(layout)) throw new Error(`Unknown layout: ${layout}`);
  const names = new Map(), emitted = new Set(), declared = {};
  function name(id) {
    if (!names.has(id)) names.set(id, label(names.size));
    return names.get(id);
  }
  function reference(id) {
    const key = name(id);
    if (emitted.has(id)) return { $ref: key };
    emitted.add(id);
    const body = emit(graph.$defs[id]);
    // A referenced definition may itself reduce to a resource declaration.
    // Keep both resource identities rather than overwriting the inner $id.
    const resource = typeof body === 'boolean' || Object.hasOwn(body, '$id')
      ? { $id: key, allOf: [body] }
      : { $id: key, ...body };
    if (layout === 'embedded') return resource;
    // The body is emitted first, so dependencies precede their dependents.
    declared[key] = resource;
    return { $ref: key };
  }
  function emit(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(emit);
    if (value.$ref) {
      const target = reference(value.$ref.slice('#/$defs/'.length));
      const siblings = Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== '$ref').map(([key, child]) => [key, emit(child)]));
      // $ref siblings conjoin in Draft 2020-12. Keep their lexical scope intact.
      return Object.keys(siblings).length
        ? { ...siblings, allOf: [...(siblings.allOf ?? []), target] }
        : target;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, emit(child)]));
  }
  const { $defs, ...root } = graph;
  // A deterministic document namespace avoids ordinary collisions when several
  // generated schemas are registered together. This is an identifier, not a digest
  // used for authentication. All child names remain relative sibling URLs.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(graph))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  const schema = { $id: `https://schema-calc.invalid/${hash.toString(16)}/`, ...emit(root) };
  // Moved pieces sit two levels down, in $defs, so every piece keeps that margin.
  // Bottom up, the tallest subschemas of an over-budget node move out first.
  const budget = maxDepth - 2, moved = {};
  let fresh = 0;
  function fit(node) {
    const slots = [];
    let fixed = 1;
    for (const [key, child] of Object.entries(node)) {
      if (SUBSCHEMA.has(key)) slots.push({ parent: node, key, extra: 1 });
      else if (SUBSCHEMA_MAPS.has(key)) {
        for (const item of Object.keys(child)) slots.push({ parent: child, key: item, extra: 2 });
      } else fixed = Math.max(fixed, 1 + height(child));
    }
    for (const slot of slots) {
      const child = slot.parent[slot.key];
      slot.height = slot.extra + (typeof child === 'object' ? fit(child) : 0);
    }
    for (const slot of slots.sort((a, b) => b.height - a.height)) {
      if (slot.height <= budget) break;
      // Every resource name is one relative segment of the same namespace, so a
      // reference inside a moved piece still resolves to the same resource. New
      // names are numbers: json-sKema 0.32 ignores an $id that ends its enclosing
      // resource's URI, so no letter name may be a suffix of an enclosing name.
      const child = slot.parent[slot.key], id = child.$id ?? String(fresh++);
      moved[id] = child.$id ? child : { $id: id, ...child };
      slot.parent[slot.key] = { $ref: id };
      slot.height = slot.extra + 1;
    }
    const result = Math.max(fixed, ...slots.map(slot => slot.height));
    if (result > budget) throw new Error(`A schema node cannot fit within ${maxDepth} levels.`);
    return result;
  }
  fit(schema);
  Object.values(declared).forEach(fit);
  if (Object.keys(declared).length || Object.keys(moved).length) schema.$defs = { ...declared, ...moved };
  return { schema, resources: emitted.size + fresh };
}

/** Enumerate embedded resources in dependency order, without retrieving URLs. */
export function schemaResources(schema) {
  // A resource depends on the resources it embeds and those it references. Pieces
  // in root $defs are referenced from earlier in the document, so sort the graph.
  const found = new Map();
  function walk(value, base, owner) {
    if (!value || typeof value !== 'object') return;
    let uri = base;
    if (value.$id) {
      uri = new URL(value.$id, base).href;
      found.set(uri, { uri, schema: value, needs: new Set() });
      found.get(owner)?.needs.add(uri);
      owner = uri;
    }
    if (typeof value.$ref === 'string') found.get(owner).needs.add(new URL(value.$ref, uri).href);
    for (const child of Object.values(value)) walk(child, uri, owner);
  }
  walk(schema, schema.$id, null);
  const resources = [], done = new Set();
  function visit(uri) {
    if (done.has(uri) || !found.has(uri)) return;
    done.add(uri);
    found.get(uri).needs.forEach(visit);
    resources.push({ uri, schema: found.get(uri).schema });
  }
  found.forEach((_, uri) => visit(uri));
  return resources;
}
