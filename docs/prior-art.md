# Prior art and project positioning

Schema Calc's artifact is a standard JSON Schema file that checks exact bounded arithmetic. It supports the original decimal-string representation and an optional tally representation with much smaller schemas. Its contribution is the compiler and its measured, portable output. No claim of priority or new computational expressiveness is made.

## Established foundations

Representing linear integer constraints with finite automata is longstanding. Wolper and Boigelot's 1995 [An Automata-Theoretic Approach to Presburger Arithmetic Constraints](https://orbi.uliege.be/handle/2268/74877) describes automata for sets of integer vectors satisfying Presburger constraints. The [MONA publications](https://www.brics.dk/mona/publications.html) also document automata and decision-diagram techniques for logical constraints. Arithmetic-to-automata compilation, shared decision graphs, and radix decomposition should not be presented as inventions of this project.

Modern JSON Schema also has substantial existing expressiveness research. [Validation of Modern JSON Schema: Formalization and Complexity](https://arxiv.org/html/2307.10034v2) analyzes its formal semantics and the complexity introduced by dynamic references. The original encoding uses an acyclic graph of static references. The tally encoding uses static recursive references that consume child columns. Neither uses dynamic references; that complexity result is not the basis of either arithmetic construction.

## Related practical approaches

The JSON Schema project's [Hyperborea article](https://json-schema.org/blog/posts/hyperborea) demonstrates arithmetic validation with an Ajv custom `sumOf` keyword and JavaScript implementation. [Ajv's `$data` references](https://ajv.js.org/guide/combining-schemas.html#data-reference) allow some keyword values to depend on instance data. These solve related problems by extending the standard validator's facilities.

Schema Calc instead pays a compilation and file-size cost to encode a finite arithmetic relation using standard keywords. A generated file can be used unchanged by Ajv and Python jsonschema. The current domain is deliberately bounded and represented by canonical decimal strings, which makes individual digits inspectable with standard `pattern` predicates. It does not add arithmetic operators for arbitrary JSON numbers.

## Contribution and scope

- A concrete output: download a schema, send it to an independent validator, and reject an incorrect invoice without installing this compiler in the receiving application.
- A checkable construction: a carry invariant, a mixed-radix transition proof, and exact domain restrictions.
- A measured improvement: the same invoice contract shrank from 284,300 to 57,050 and then 41,232 uncompressed bytes, with frozen baselines and a reproducible comparison. Packing trades validator speed for file size. The later tally encoding reaches 3,569 bytes by changing the input representation; it uses native counting and reusable carry states, with explicit input-size and conversion costs.
- Independent evidence: the same 24,472 records across 31 schemas pass Ajv and Python jsonschema, alongside a proof sketch rather than tests alone. The tally format separately passes 24,473 records across 36 schemas, including forged constants and repeated-field copies.

The project explores compiling useful computations into a restrictive host. Its family resemblance to regex arithmetic is deliberate: a familiar declarative format becomes an unexpected execution target. The exported schema, rather than a compiler-specific runtime, is the artifact a receiving application uses.

A focused literature and web search did not establish whether a prior compiler offers this exact combination. Absence from those results is not evidence of priority. A research novelty claim would need a more systematic comparison and an evaluation across many constraint families. The claims here concern the portable artifact, the construction, and measured optimization.

The tally construction uses established unary representation, complement arithmetic, finite-state carries, native cardinality constraints, and recursive schemas. Its smaller artifacts are an engineering result under a changed wire format, not evidence of a new arithmetic algorithm or a priority claim. See [tally.md](tally.md).
