import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import {synthesize,evaluateProgram,points} from '../bench/superoptimizer/search.mjs';
import {compile} from '../bench/superoptimizer/compiler.mjs';
import {presets} from '../src/presets.mjs';
import {workload} from '../bench/superoptimizer/workload.mjs';

test('synthesis represents every two-input Boolean function exactly',()=>{
  for(let mask=0;mask<16;mask++) for(const weight of [0,400]) {
    const labels=Array.from({length:4},(_,i)=>Boolean(mask&(1<<i)));
    const result=synthesize(2,2,labels,{weight});
    points(2,2).forEach((row,i)=>assert.equal(evaluateProgram(result.node,row),Boolean(mask&(1<<i))));
  }
});
test('quinary decision programs preserve signed sums and carry labels exhaustively',()=>{
  for(const ca of [-3,-1,1,2])for(const cb of [-2,-1,1,3])for(const carry of [-4,0,4]) {
    const labels=points(5,2).map(([a,b])=>(ca*a+cb*b+carry)%5===0 ? (ca*a+cb*b+carry)/5 : false);
    const result=synthesize(5,2,labels,{weight:24});
    for(let a=0;a<5;a++)for(let b=0;b<5;b++) {
      const sum=ca*a+cb*b+carry;
      assert.equal(evaluateProgram(result.node,[a,b]),sum%5===0 ? sum/5 : false);
    }
  }
});
test('bounded search falls back safely and generated schemas remain deterministic',()=>{
  const spec={fields:['a','b','total'],constraints:['a+b=total'],integerDigits:1,scale:0};
  const result=compile(spec,{maxStates:1});
  assert.ok(result.stats.search.budgetFallbacks>0);
  const validate=new Ajv2020({strict:true,inlineRefs:false}).compile(result.schema);
  for(let a=0;a<10;a++)for(let b=0;b<10;b++)for(let total=0;total<10;total++)
    assert.equal(validate({a:String(a),b:String(b),total:String(total)}),a+b===total);
  assert.deepEqual(compile(spec).schema,compile(spec).schema);
});
test('held-out benchmark arithmetic and declared labels have an independent integer oracle',()=>{
  const integer=s=>BigInt(s.replace('.',''));
  for(const name of Object.keys(presets)) {
    const data=workload(name);
    for(const label of ['valid','invalid'])for(const row of data[label]) {
      const accepted=name==='invoice' ? integer(row.total)===integer(row.subtotal)+integer(row.shipping)-integer(row.discount)
        : name==='carry' ? integer(row.result)===integer(row.balance)+integer(row.deposit)
          : integer(row.research)+integer(row.engineering)+integer(row.operations)===10000n;
      assert.equal(accepted,label==='valid');
    }
  }
});
