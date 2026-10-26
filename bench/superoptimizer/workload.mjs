// Held-out benchmark inputs. Equations below are evaluated with independent
// integer arithmetic; generation never asks a schema whether a record is valid.
export function workload(name, seed=0x23c0ffee) {
  function random(limit) {seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed%limit;}
  const money=n=>`${Math.floor(n/100)}.${String(n%100).padStart(2,'0')}`;
  const valid=[]; let target,limit;
  for(let i=0;i<32;i++) {
    if(name==='invoice') {
      let a=random(1000000),b=random(1000000-a),c=random(a+b+1);
      if(i===0) a=b=c=0;
      if(i===1) {a=999999;b=0;c=0;}
      valid.push({subtotal:money(a),shipping:money(b),discount:money(c),total:money(a+b-c)});
      target='total';limit=1000000;
    } else if(name==='allocation') {
      let a=random(10001),b=random(10001-a);
      if(i===0) {a=10000;b=0;}
      if(i===1) {a=3333;b=3333;}
      valid.push({research:money(a),engineering:money(b),operations:money(10000-a-b)});
      target='operations';limit=100000;
    } else if(name==='carry') {
      let a=random(1000000),b=random(1000000-a);
      if(i===0) {a=99999;b=1;}
      if(i===1) {a=0;b=0;}
      valid.push({balance:money(a),deposit:money(b),result:money(a+b)});
      target='result';limit=1000000;
    } else throw Error(name);
  }
  const invalid=valid.map((row,i)=> {
    const old=Number(row[target].replace('.',''));
    return {...row,[target]:money((old+10**(i%6))%limit===old ? (old+1)%limit : (old+10**(i%6))%limit)};
  });
  const malformed=[{...valid[0],[target]:0},{...valid[0],[target]:'01.00'},
    {...valid[0],[target]:valid[0][target]+'\n'},{...valid[0],extra:'0.00'},null,[],
    Object.fromEntries(Object.entries(valid[0]).filter(([key])=>key!==target)),{...valid[0],[target]:'1.0'}];
  return {valid,invalid,malformed};
}
