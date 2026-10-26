/** Pack a static $defs graph as a self-contained compound schema document.
 * A shared node is declared at its first use; later uses refer to its short $id.
 * The reserved .invalid origin identifies bundled resources, not network files.
 */
export function packResources(graph) {
  const names = new Map(), emitted = new Set();
  function name(id) {
    if (!names.has(id)) {
      let n = names.size, key = '';
      do {
        key = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 52] + key;
        n = Math.floor(n / 52) - 1;
      } while (n >= 0);
      names.set(id, key);
    }
    return names.get(id);
  }
  function reference(id) {
    const key = name(id);
    if (emitted.has(id)) return { $ref: key };
    emitted.add(id);
    const body = emit(graph.$defs[id]);
    // A referenced definition may itself reduce to a resource declaration.
    // Keep both resource identities rather than overwriting the inner $id.
    return typeof body === 'boolean' || Object.hasOwn(body, '$id')
      ? { $id: key, allOf: [body] }
      : { $id: key, ...body };
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
  return { schema, resources: emitted.size };
}

/** Enumerate embedded resources in dependency order, without retrieving URLs. */
export function schemaResources(schema) {
  const resources = [];
  function walk(value, base) {
    if (!value || typeof value !== 'object') return;
    const uri = value.$id ? new URL(value.$id, base).href : base;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(item => walk(item, uri));
      else walk(child, uri);
    }
    if (value.$id) resources.push({ uri, schema: value });
  }
  walk(schema, schema.$id);
  return resources;
}
