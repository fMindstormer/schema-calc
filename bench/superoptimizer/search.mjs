/** Bounded, exact decision-program synthesis over a finite arithmetic truth table.
 * Grammar: constants/continuations, field-subset tests, binary XOR and native
 * exactly-one tests, and if/then/else. No claim of global JSON Schema optimality.
 * Search is exact for a fixed test grammar and additive cost model when it
 * finishes within the state budget. Actual schema size/speed are measured later.
 */
export const searchCache = new Map();
export const searchStats = { searches: 0, hits: 0, states: 0, partitions: 0, verifiedRows: 0, budgetFallbacks: 0 };
const bit = i => (2 ** i) >>> 0;
const popcount = n => { let count=0; for (; n; n &= n-1) count++; return count; };

export function points(radix, arity) {
  return Array.from({length: radix ** arity}, (_, i) => Array.from({length: arity}, () => {
    const value = i % radix; i = Math.floor(i/radix); return value;
  }));
}
export function evaluateTest(test, row) {
  if (test.kind === 'set') return Boolean(test.set & (1 << row[test.field]));
  if (test.kind === 'one') return test.args.filter(t => evaluateTest(t, row)).length === 1;
  throw new Error(`Unknown test ${test.kind}`);
}
export function evaluateProgram(program, row) {
  return program.kind === 'leaf' ? program.value : evaluateProgram(
    evaluateTest(program.test, row) ? program.yes : program.no, row);
}

export function synthesize(radix, arity, labels, {weight=0, macros=true, maxStates=70000}={}) {
  if (![2,5].includes(radix) || arity < 1 || radix ** arity > 25) throw new Error('Search limited to at most 25 rows.');
  const rows = points(radix, arity);
  if (labels.length !== rows.length) throw new Error('Incomplete truth table');
  const key = JSON.stringify([radix, arity, labels, weight, macros, maxStates]);
  if (searchCache.has(key)) { searchStats.hits++; return searchCache.get(key); }
  const all = bit(rows.length)-1, tests = new Map();
  function add(test, bytes, work) {
    const mask = rows.reduce((m, row, i) => evaluateTest(test,row) ? (m|bit(i)) : m, 0) >>> 0;
    if (!mask || mask === all) return;
    // Both orientations are considered when partitioning; complements duplicate a test.
    const canonical = Math.min(mask, (all ^ mask) >>> 0), prior = tests.get(canonical);
    if (!prior || bytes + weight*work < prior.bytes + weight*prior.work) tests.set(canonical, {test, mask, bytes, work});
  }
  for (let field=0;field<arity;field++) for (let set=1;set<(1<<radix);set++) {
    if (set & 1) continue; // Complement costs are charged by the branch encoder.
    add({kind:'set',field,set}, 23, 1);
  }
  if (radix === 2 && macros) {
    // Enumerate native oneOf over every subset and polarity of binary components.
    // For two children this also enumerates XOR/equivalence tests.
    for(let selected=1;selected<(1<<arity);selected++) {
      const fields=Array.from({length:arity},(_,i)=>i).filter(i => selected&(1<<i));
      if(fields.length < 2) continue;
      for(let polarities=0;polarities<(1<<fields.length);polarities++) {
        const args=fields.map((field,i)=>({kind:'set',field,set:polarities&(1<<i)?1:2}));
        add({kind:'one',args}, 12 + args.reduce((sum,t)=>sum+23+(t.set===1?8:0),0), args.length);
      }
    }
  }
  const atoms=[...tests.values()], memo=new Map(); let partitions=0;
  function solve(domain) {
    if(memo.has(domain)) return memo.get(domain);
    if(memo.size >= maxStates) throw new Error('search budget');
    let first=-1, uniform=true;
    for(let i=0;i<labels.length;i++) if(domain&bit(i)) {
      if(first === -1) first=i; else if(labels[i] !== labels[first]) {uniform=false;break;}
    }
    if(uniform) {
      const answer={node:{kind:'leaf',value:labels[first]}, bytes:0, work:0, expected:0, score:0};
      memo.set(domain,answer); return answer;
    }
    // Memoize a placeholder to account for live recursive states in the budget.
    memo.set(domain,null); let best;
    const splits=new Map();
    for(const atom of atoms) {
      const yes=(domain&atom.mask)>>>0, no=(domain^yes)>>>0;
      if(!yes || !no) continue;
      const split=Math.min(yes,no), prior=splits.get(split);
      if(!prior || atom.bytes+weight*(popcount(domain)/rows.length)*atom.work < prior.atom.bytes+weight*(popcount(domain)/rows.length)*prior.atom.work) splits.set(split,{atom,yes,no});
    }
    for(const {atom,yes,no} of splits.values()) {
      partitions++;
      const y=solve(yes), n=solve(no);
      // Shortened conjunction/implication forms when one branch is constant.
      const constantY=y.node.kind==='leaf' && typeof y.node.value==='boolean';
      const constantN=n.node.kind==='leaf' && typeof n.node.value==='boolean';
      const overhead=constantY && constantN ? 8 : constantY || constantN ? 23 : 45;
      const bytes=atom.bytes+overhead+y.bytes+n.bytes;
      const work=atom.work+Math.max(y.work,n.work);
      const expected=atom.work+(popcount(yes)*y.expected+popcount(no)*n.expected)/popcount(domain);
      const score=bytes+weight*(popcount(domain)/rows.length)*expected;
      if(!best || score<best.score || (score===best.score && work<best.work)) best={
        node:{kind:'if',test:atom.test,yes:y.node,no:n.node},bytes,work,expected,score
      };
    }
    if(!best) throw new Error('Incomplete test grammar');
    memo.set(domain,best); return best;
  }
  let result;
  try { result=solve(all); }
  catch(error) { if(error.message!=='search budget') throw error; searchStats.budgetFallbacks++; result=null; }
  searchStats.searches++; searchStats.states+=memo.size; searchStats.partitions+=partitions;
  if(result) {
    rows.forEach((row,i)=>{if(evaluateProgram(result.node,row)!==labels[i])throw new Error('Synthesized program disagrees with truth table');});
    searchStats.verifiedRows+=rows.length;
    result={...result, search:{states:memo.size, partitions, atoms:atoms.length, rows:rows.length}};
  }
  searchCache.set(key,result); return result;
}
