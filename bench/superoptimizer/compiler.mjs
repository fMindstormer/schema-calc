// Experimental compiler: production remains unchanged.
import { synthesize, points, searchStats } from './search.mjs';
import { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../../src/syntax.mjs';
import { packResources } from '../../src/resources.mjs';

const RADICES = [2, 5];
const ALL_DIGITS = (1 << 10) - 1;
const MAX_DEFINITIONS = 40000;

function digitClass(mask) {
  const digits = Array.from({ length: 10 }, (_, n) => n).filter(n => mask & (1 << n));
  if (digits.length === 1) return String(digits[0]);
  let text = '';
  for (let i = 0; i < digits.length; i++) {
    let j = i;
    while (j + 1 < digits.length && digits[j + 1] === digits[j] + 1) j++;
    text += j - i >= 2 ? `${digits[i]}-${digits[j]}` : digits.slice(i, j + 1).join('');
    i = j;
  }
  return `[${text}]`;
}
function pattern(position, mask, scale) {
  // Root checks fix the decimal point and exclude line breaks. Only the target
  // digit needs a character class; the known suffix can be skipped with dots.
  const offset = position + (scale > 0 && position >= scale ? 1 : 0);
  const suffix = offset === 0 ? '' : offset === 1 ? '.' : `.{${offset}}`;
  return `${digitClass(mask)}${suffix}$`;
}

export function compile(input, {mode='both', weight=24, packed=false, macros=true, maxStates=70000}={}) {
  if(!['none','binary','pairs','both'].includes(mode) || !Number.isFinite(weight) || weight<0) throw new Error('Invalid search configuration');
  const beforeSearch = {...searchStats}; let synthesizedCells=0;
  const spec = normalizeSpec(input), width = spec.integerDigits + spec.scale;
  const equations = spec.constraints.map(source => parseEquation(source, spec));
  const definitions = new Map(), predicates = new Map(), interned = new Map();
  let count = 0, states = 0;
  const ref = id => typeof id === 'boolean' ? id : { $ref: `#/$defs/${id}` };
  function add(schema) {
    if (definitions.size >= MAX_DEFINITIONS) throw new Error(`Compilation exceeded the ${MAX_DEFINITIONS} definition limit.`);
    // Alphabetic IDs preserve insertion order in JSON objects. Dependencies are
    // inserted before their parents, allowing bottom-up validator preparation.
    let n = count++, key = '';
    do {
      key = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 52] + key;
      n = Math.floor(n / 52) - 1;
    } while (n >= 0);
    definitions.set(key, schema);
    return key;
  }
  const strings = new Map();
  function predicate(field, position, mask) {
    const key = `${field}:${position}:${mask}`;
    if (!predicates.has(key)) {
      const stringKey = `${position}:${mask}`;
      // Share the string-level digit test even when it is applied to different fields.
      if (!strings.has(stringKey)) {
        strings.set(stringKey, add({ type: 'string', pattern: pattern(position, mask, spec.scale) }));
      }
      predicates.set(key, add({ type: 'object', properties: { [field]: ref(strings.get(stringKey)) } }));
    }
    return predicates.get(key);
  }
  function branch(field, position, mask, yes, no) {
    if (yes === no) return yes;
    // Always test a set excluding zero. An absent leading digit then fails the
    // predicate, exactly as a virtual zero should; no padding alternative is needed.
    if (mask & 1) {
      mask ^= ALL_DIGITS;
      [yes, no] = [no, yes];
    }
    const test = predicate(field, position, mask);
    if (yes === true && no === false) return test;
    let node;
    if (yes === false && no === true) node = { not: ref(test) };
    else if (no === false) node = { allOf: [ref(test), ref(yes)] };
    else if (yes === false) node = { allOf: [{ not: ref(test) }, ref(no)] };
    else if (no === true) node = { if: ref(test), then: ref(yes) };
    else if (yes === true) node = { if: ref(test), else: ref(no) };
    else node = { if: ref(test), then: ref(yes), else: ref(no) };
    const key = JSON.stringify(node);
    if (!interned.has(key)) interned.set(key, add(node));
    return interned.get(key);
  }
  function choose(field, position, values, divisor, radix) {
    const groups = new Map();
    // Several component values often have the same continuation. Test their union.
    values.forEach((child, value) => {
      if (!groups.has(child)) groups.set(child, []);
      groups.get(child).push(value);
    });
    function tree(items) {
      if (items.length === 1) return items[0][0];
      const middle = Math.ceil(items.length / 2), left = items.slice(0, middle), right = items.slice(middle);
      const selected = new Set(left.flatMap(([, digits]) => digits));
      let mask = 0;
      for (let d = 0; d < 10; d++) {
        if (selected.has(Math.floor(d / divisor) % radix)) mask |= 1 << d;
      }
      return branch(field, position, mask, tree(left), tree(right));
    }
    return tree([...groups]);
  }
  function intern(node) {
    const key=JSON.stringify(node);
    if(!interned.has(key)) interned.set(key,add(node));
    return interned.get(key);
  }
  function conditional(test, yes, no) {
    if(yes===no) return yes;
    if(yes===true && no===false) return test;
    if(yes===false && no===true) return intern({not:ref(test)});
    if(no===false) return intern({allOf:[ref(test),ref(yes)]});
    if(yes===false) return intern({allOf:[{not:ref(test)},ref(no)]});
    if(no===true) return intern({if:ref(test),then:ref(yes)});
    if(yes===true) return intern({if:ref(test),else:ref(no)});
    return intern({if:ref(test),then:ref(yes),else:ref(no)});
  }
  function emitProgram(node, fields, position, divisor, radix, continuations) {
    function test(t) {
      if(t.kind==='one') return intern({oneOf:t.args.map(a=>ref(test(a)))});
      let mask=0;
      for(let d=0;d<10;d++) if(t.set&(1<<(Math.floor(d/divisor)%radix))) mask|=1<<d;
      return branch(fields[t.field],position,mask,true,false);
    }
    if(node.kind==='leaf') return typeof node.value==='boolean' ? node.value : continuations[node.value];
    return conditional(test(node.test), emitProgram(node.yes,fields,position,divisor,radix,continuations),
      emitProgram(node.no,fields,position,divisor,radix,continuations));
  }
  const roots = equations.map(({ source, terms, constant }) => {
    const memo = new Map();
    const digits = (constant < 0n ? -constant : constant).toString()
      .padStart(width, '0').split('').reverse()
      .map(d => Number(d) * (constant < 0n ? -1 : 1));
    function build(position, stage, operand, balance) {
      if (position === width) return BigInt(balance) + constant / (10n ** BigInt(width)) === 0n;
      if (stage === 0 && operand === 0) balance += digits[position] ?? 0;
      const key = `${position}:${stage}:${operand}:${balance}`;
      if (memo.has(key)) return memo.get(key);
      states++;
      let result;
      // d = (d mod 2) + 2 floor(d/2). Requiring divisibility by 2 and then
      // by 5 is exactly the original decimal-column divisibility test.
      const radix = RADICES[stage];
      if (operand === terms.length) {
        if (balance % radix !== 0) result = false;
        else if (stage === RADICES.length - 1) result = build(position + 1, 0, 0, balance / radix);
        else result = build(position, stage + 1, 0, balance / radix);
      } else if ((stage===0 && ['binary','both'].includes(mode) && operand===0 && terms.length<=4) ||
        (stage===1 && ['pairs','both'].includes(mode) && operand===Math.max(0,terms.length-2))) {
        const tail=terms.slice(operand), divisor=stage===0?1:2, continuations=[];
        const labels=points(radix,tail.length).map(row=> {
          const sum=balance+row.reduce((s,d,i)=>s+d*tail[i][1],0);
          const next=sum%radix!==0 ? false : stage===1 ? build(position+1,0,0,sum/radix) : build(position,1,0,sum/radix);
          if(typeof next==='boolean') return next;
          let index=continuations.indexOf(next);
          if(index<0) {index=continuations.length;continuations.push(next);}
          return index;
        });
        const program=synthesize(radix,tail.length,labels,{weight,macros,maxStates});
        if(program) {
          synthesizedCells++;
          result=emitProgram(program.node,tail.map(t=>t[0]),position,divisor,radix,continuations);
        } else {
          const [field,coefficient]=terms[operand];
          result=choose(field,position,Array.from({length:radix},(_,d)=>build(position,stage,operand+1,balance+coefficient*d)),divisor,radix);
        }
      } else {
        const [field, coefficient] = terms[operand];
        const children = Array.from({ length: radix }, (_, d) =>
          build(position, stage, operand + 1, balance + coefficient * d));
        const divisor = RADICES.slice(0, stage).reduce((a, b) => a * b, 1);
        result = choose(field, position, children, divisor, radix);
      }
      memo.set(key, result);
      return result;
    }
    return { $comment: source, allOf: [ref(build(0, 0, 0, 0))] };
  });

  // Count incoming references once per live definition, rather than once per
  // expanded path. This is the graph's initial physical reference count.
  const live = new Set(), uses = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const key = node.$ref.slice('#/$defs/'.length);
      uses.set(key, (uses.get(key) || 0) + 1);
      if (!live.has(key)) {
        live.add(key);
        visit(definitions.get(key));
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== '$ref') {
      if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  }
  roots.forEach(visit);
  const inline = new Set();
  function childRefs(node, action) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) action(node.$ref.slice('#/$defs/'.length));
    for (const [key, value] of Object.entries(node)) if (key !== '$ref') {
      if (Array.isArray(value)) value.forEach(v => childRefs(v, action));
      else childRefs(value, action);
    }
  }
  // Parents first: inlining n copies replaces one definition, so each direct
  // child gains n-1 physical references. Small nodes can cost less than $refs.
  for (const [key, node] of [...definitions].reverse()) {
    if (!live.has(key)) continue;
    const n = uses.get(key), size = JSON.stringify(node).length;
    // Price the chosen layout: packed resources keep n-1 short references;
    // flat definitions keep their entry and n full JSON Pointer references.
    const sharedSize = packed ? size + key.length + 9 + (n - 1) * (key.length + 11)
      : size + JSON.stringify(key).length + 2 + n * JSON.stringify(ref(key)).length;
    if (n * size <= sharedSize) {
      inline.add(key);
      childRefs(node, child => uses.set(child, uses.get(child) + n - 1));
    }
  }
  function emit(node) {
    if (!node || typeof node !== 'object') return node;
    // Before emission all generated references are standalone {$ref: ...} nodes.
    if (node.$ref && inline.has(node.$ref.slice('#/$defs/'.length))) {
      return emit(definitions.get(node.$ref.slice('#/$defs/'.length)));
    }
    if (Array.isArray(node)) return node.map(emit);
    const result = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, emit(value)]));
    // These keywords conjoin independently. Never merge conditional keywords:
    // a then/else in one allOf branch cannot acquire an if from another branch.
    const mergeable = item => item && typeof item === 'object' &&
      Object.keys(item).every(k => ['type', 'properties', '$ref', 'not'].includes(k));
    if (result.allOf && result.allOf.every(mergeable)) {
      const merged = {};
      let compatible = true;
      for (const item of result.allOf) for (const [key, value] of Object.entries(item)) {
        if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) compatible = false;
        merged[key] = value;
      }
      if (compatible) {
        delete result.allOf;
        Object.assign(result, merged);
      }
    }
    return result;
  }
  const graph = {
    $schema: DRAFT,
    title: spec.title,
    type: 'object', required: spec.fields, additionalProperties: false,
    properties: Object.fromEntries(spec.fields.map(f => [f, {
      type: 'string', pattern: amountPattern(spec.integerDigits, spec.scale)
    }])),
    allOf: roots.map(emit),
    $defs: Object.fromEntries([...definitions]
      .filter(([key]) => live.has(key) && !inline.has(key))
      .map(([key, node]) => [key, emit(node)]))
  };
  const { schema, resources } = packed ? packResources(graph) : {schema:graph,resources:Object.keys(graph.$defs).length};
  const decisionIds = new Set(interned.values());
  return { schema, stats: {
    synthesizedCells, search: Object.fromEntries(Object.entries(searchStats).map(([k,v])=>[k,v-beforeSearch[k]])),
    bytes: new TextEncoder().encode(JSON.stringify(schema)).length,
    definitions: resources,
    decisionNodes: [...live].filter(id => decisionIds.has(id)).length,
    predicates: [...predicates.values()].filter(id => live.has(id)).length,
    exploredStates: states,
    maxDigitTests: null // Use measured runtime; synthesized programs may repeat predicates.
  } };
}

export { normalizeSpec, parseEquation, amountPattern, DRAFT } from '../../src/syntax.mjs';
