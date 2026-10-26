// REJECTED RESEARCH PROTOTYPE. Smoke-tested on the three presets only, not the
// full correctness corpus. Local Boolean sums plus an explicit carry automaton
// still cause excessive repeated evaluation inside a column. Not a supported API.
import {normalizeSpec,parseEquation,amountPattern,DRAFT} from '../../src/syntax.mjs';
import {packResources} from '../../src/resources.mjs';

export function compile(input,{packed=false}={}){
 const spec=normalizeSpec(input),width=spec.integerDigits+spec.scale,M=10n**BigInt(width);
 const defs=new Map(),cache=new Map();let serial=0;
 const ref=x=>typeof x==='boolean'?x:{$ref:'#/$defs/'+x};
 function add(node){const k=JSON.stringify(node);if(!cache.has(k)){const id=(serial++).toString(36);cache.set(k,id);defs.set(id,node);}return cache.get(k);}
 const negs=new Map();
 function not(x){if(typeof x==='boolean')return !x;if(negs.has(x))return negs.get(x);const n=add({not:ref(x)});negs.set(n,x);negs.set(x,n);return n;}
 function xor(a,b){if(a===b)return false;if(a===false)return b;if(b===false)return a;if(a===true)return not(b);if(b===true)return not(a);if(a===negs.get(b))return true;return add({oneOf:[a,b].sort().map(ref)});}
 function and(a,b){if(a===false||b===false)return false;if(a===true)return b;if(b===true)return a;if(a===b)return a;if(a===negs.get(b))return false;return add({allOf:[a,b].sort().map(ref)});}
 function mux(p,a,b){if(a===b)return a;if(p===true)return a;if(p===false)return b;if(a===true&&b===false)return p;if(a===false&&b===true)return not(p);return add({if:ref(p),then:ref(a),else:ref(b)});}
 function full(a,b,c){const p=xor(a,b);return [xor(p,c),mux(p,c,a)];}
 function sum(vectors){const buckets=[];for(const v of vectors)v.forEach((x,i)=>(buckets[i]??=[]).push(x));
  for(let i=0;i<buckets.length;i++){while(buckets[i].length>2){const [s,c]=full(...buckets[i].splice(-3));buckets[i].push(s);if(c!==false)(buckets[i+1]??=[]).push(c);}}
  const out=[];let carry=false;
  for(let i=0;i<buckets.length;i++){let [s,c]=full(buckets[i][0]??false,buckets[i][1]??false,carry);out.push(s);carry=c;}if(carry!==false)out.push(carry);return out;
 }
 const bits=n=>n===0?[]:Array.from({length:Math.floor(Math.log2(n))+1},(_,i)=>!!(n&(2**i)));
 function digit(field,pos,bit,flip){let mask=0;for(let d=0;d<10;d++)if(((flip?9-d:d)>>bit)&1)mask|=1<<d;let inverse=!!(mask&1);if(inverse)mask^=1023;
  const digits=Array.from({length:10},(_,d)=>d).filter(d=>mask&(1<<d)).join('');
  const offset=pos+(spec.scale&&pos>=spec.scale?1:0);const pattern=`[${digits}]${offset?offset===1?'.':`.{${offset}}`:''}$`;
  const pred=add({type:'object',properties:{[field]:{type:'string',pattern}}});return inverse?not(pred):pred;
 }
 const roots=spec.constraints.map(source=>{
  const {terms,constant}=parseEquation(source,spec);const W=terms.reduce((s,[,c])=>s+Math.abs(c),0),N=terms.reduce((s,[,c])=>s+Math.max(0,-c),0);
  const target=BigInt(N)*(M-1n)-constant;if(target<0n||target>BigInt(W)*(M-1n))return false;
  const K=M-1n-target%M,terminal=Number(target/M),sums=[];let maxCarry=0;
  for(let pos=0;pos<width;pos++){
   const vectors=[];for(const [f,c]of terms){const v=Array.from({length:4},(_,bit)=>digit(f,pos,bit,c<0));for(let j=0;j<Math.abs(c);j++)vectors.push(v);}
   const kd=Number(K/(10n**BigInt(pos))%10n);sums.push({value:sum([...vectors,bits(kd)]),maximum:9*W+kd});maxCarry=Math.floor((9*W+kd+maxCarry)/10);
  }
  const states=new Map();
  function state(pos,carry){if(pos===width)return carry===terminal;const key=pos+':'+carry;if(states.has(key))return states.get(key);
   const value=sum([sums[pos].value,bits(carry)]),maximum=sums[pos].maximum+carry;
   const accepted=[];for(let n=9;n<=maximum;n+=10)accepted.push([n,state(pos+1,Math.floor(n/10))]);
   function decide(bit,entries){if(!entries.length)return false;if(bit===value.length)return entries[0][1];
    const a=decide(bit+1,entries.filter(([n])=>n&(2**bit))),b=decide(bit+1,entries.filter(([n])=>!(n&(2**bit))));return mux(value[bit],a,b);
   }const root=decide(0,accepted);states.set(key,root);return root;
  }return ref(state(0,0));
 });
 const uses=new Map(),live=new Set();
 function scan(v){if(!v||typeof v!=='object')return;if(v.$ref){const id=v.$ref.slice(8);uses.set(id,(uses.get(id)||0)+1);if(!live.has(id)){live.add(id);scan(defs.get(id));}}else for(const v2 of Object.values(v))Array.isArray(v2)?v2.forEach(scan):scan(v2);}
 roots.forEach(scan);const inline=new Set();
 for(const[id,v]of[...defs].reverse()){if(!live.has(id))continue;const n=uses.get(id),len=JSON.stringify(v).length;if(n*len<=len+id.length+4+n*(id.length+19)){inline.add(id);function inc(v){if(!v||typeof v!=='object')return;if(v.$ref){const j=v.$ref.slice(8);uses.set(j,uses.get(j)+n-1);}else for(const z of Object.values(v))Array.isArray(z)?z.forEach(inc):inc(z);}inc(v);}}
 function emit(v){if(!v||typeof v!=='object')return v;if(v.$ref&&inline.has(v.$ref.slice(8)))return emit(defs.get(v.$ref.slice(8)));if(Array.isArray(v))return v.map(emit);return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,emit(x)]));}
 let schema={$schema:DRAFT,title:spec.title,type:'object',required:spec.fields,additionalProperties:false,properties:Object.fromEntries(spec.fields.map(f=>[f,{type:'string',pattern:amountPattern(spec.integerDigits,spec.scale)}])),allOf:roots.map(emit),$defs:Object.fromEntries([...defs].filter(([id])=>live.has(id)&&!inline.has(id)).map(([id,v])=>[id,emit(v)]))};
 if(packed)schema=packResources(schema).schema;
 return {schema,stats:{bytes:JSON.stringify(schema).length,definitions:live.size-inline.size,nodes:live.size}};
}
