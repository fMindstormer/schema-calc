# Design and correctness

This document describes the original decimal-string encoding. The optional counting-based encoding changes the wire format and uses a recursive carry automaton; see [tally.md](tally.md) for its separate representation, proof, and limits.

## Domain

All fields use the same decimal precision. Let `D = integerDigits + scale`. Removing the decimal point maps each valid field string to an integer in `[0, 10^D)`. The schema's root checks guarantee this domain before the arithmetic claim applies. Leading zeroes, a missing decimal part, signs, non-ASCII digits and trailing characters are excluded.

Each root field check pairs two patterns: `^…$` for the decimal shape, and `not: {pattern: "[^.0-9]"}`, which rejects any string containing another character. JSON Schema specifies ECMAScript regexes, but validators commonly run patterns in their host language's engine. In Python, Java and .NET, `$` also matches before a final line terminator, so `"1.00\n"` would pass the shape test alone; the character test excludes it. The obvious alternative, ending with the absolute end assertion `(?![\s\S])`, needs lookahead, which Go's RE2 lacks. Without lookahead, every common dialect gives the pair the same meaning. Internal digit predicates can therefore use a bare `$` anchor too: any malformed input is rejected by the root, regardless of validation order. These internal fragments are not standalone domain validators. Missing integer digits in a positional predicate are interpreted as zero. Missing fractional digits are never allowed by the root schema.

Every internal digit predicate tests a set that excludes zero; if necessary the compiler complements the set and swaps its branches. An absent leading digit therefore fails the predicate, just as a virtual zero would. Under the root's canonical format, a suffix can be skipped with `.` or `.{n}`: its length includes the decimal point where appropriate, and line breaks cannot occur. This removes padding alternatives and repeated digit classes without changing the input domain.

## Normalization

Move the right side of the equality to the left. A term may multiply a field by a whole number from 1 to 1,000, written `3 * a` or `a * 3`. Combine each field's terms into one signed integer coefficient; remove zero coefficients. Parse decimal constants using BigInt and scale them into minor units. Individual constants must fit the declared precision, but their combined signed sum may exceed one field's width.

A constraint relates its two sides by `=`, `<=`, `>=`, `<` or `>`. Every inequality normalizes to `S ≤ 0`, where `S = Σ cᵢxᵢ + C`. For `≥` and `>`, negate every coefficient and the constant. Fields and constants are whole numbers of minor units, so `S < 0` exactly when `S + 1 ≤ 0`: a strict comparison adds one unit to `C`.

No record's numeric value is evaluated by the compiler: only the contract is input to compilation. Numeric operations used during compilation concern finite states, digit values and constants known before any record exists.

## State transition

For position `j`, enumerate each field's digit `dᵢⱼ` in `0..9`. Let `kⱼ` be the signed digit of the constant's absolute value, and let `rⱼ` be the carry entering this column. The completed column balance is:

```text
sⱼ = rⱼ + Σᵢ cᵢ dᵢⱼ + kⱼ
```

If `sⱼ` is not divisible by 10, the branch rejects. Otherwise the next state has `rⱼ₊₁ = sⱼ / 10`. Start with `r₀ = 0`. After `D` positions, accept exactly when `rᴅ + trunc(constant / 10ᴅ) = 0`. The final constant term handles sums of constants larger than the declared field width.

For `S ≤ 0`, no column rejects. Let `Tⱼ` be the incoming carry plus the part of the sum not yet read: `Tⱼ = rⱼ + Σₘ≥ⱼ 10ᵐ⁻ʲ (Σᵢ cᵢdᵢₘ + kₘ) + 10ᴅ⁻ʲ · trunc(constant / 10ᴅ)`, so `T₀ = S`. Then `Tⱼ = sⱼ + 10U`, where `U` is the same sum from column `j + 1` without a carry. Write `sⱼ = 10q + r` with `0 ≤ r < 10`. `Tⱼ ≤ 0` exactly when `q + U ≤ −r/10`. Since `q + U` is an integer and `−r/10` lies in `(−1, 0]`, that holds exactly when `q + [r > 0] + U ≤ 0`, which is `Tⱼ₊₁ ≤ 0` with carry `rⱼ₊₁ = ⌈sⱼ / 10⌉`. After `D` positions the machine accepts exactly when `rᴅ + trunc(constant / 10ᴅ) ≤ 0`. The argument holds for any radix, so the mixed-radix stages below carry `⌈u / 2⌉` and `⌈v / 5⌉` instead of rejecting a remainder. The ceiling adds at most one, so carries stay bounded as for equalities.

## Smaller states through mixed radix

The optimized generator uses `dᵢⱼ = pᵢⱼ + 2qᵢⱼ`, where `pᵢⱼ = dᵢⱼ mod 2` and `qᵢⱼ = floor(dᵢⱼ / 2)`. Thus:

```text
u = rⱼ + kⱼ + Σᵢ cᵢ pᵢⱼ
v = u / 2 + Σᵢ cᵢ qᵢⱼ
sⱼ = 2v
```

The parity stage rejects odd `u`. For even `u`, the quotient stage rejects `v` not divisible by five. If both succeed, the next carry is `v / 5 = sⱼ / 10`. This is equivalent to the original transition for positive and negative balances. It uses a radix-2 stage followed by radix-5; it is not two independent congruence tests on the original digit. For an inequality neither stage rejects: `v` starts from `⌈u / 2⌉`, and the next carry is `⌈v / 5⌉`. That is the [state-transition](#state-transition) argument applied with radix 2, then radix 5.

The generator memoizes `(position, stage, operand, balance)` states. Parity branches have two values; quotient branches have five. The constant's signed digit is added once, at the start of the parity stage. Each component contributes its compile-time coefficient to the balance. A digit-set regex reads the appropriate component from the original decimal string; no transformed fields or extra input data are needed.

This decomposition reduces the range of intermediate balances before the next fields are considered. It preserves the full decimal domain, including virtual leading zeroes, and does not enumerate complete records.

## Graph reduction and schema packing

1. Group component values with identical continuations. A balanced tree tests unions of these groups, using at most one parity test and three quotient tests per field and column.
2. Collapse equal branches and Boolean continuations. For example, `if P then Q else false` becomes `allOf: [P, Q]`. Canonicalize a digit set against its complement and intern identical nodes.
3. Share string-level digit tests across fields; small object wrappers apply them through `properties`.
4. Mark live definitions and count physical incoming references. Process parents before children, comparing inline copies against one resource declaration plus `n−1` short references. Inlining `n` copies adds `n−1` references to each direct child, so update those counts before deciding about that child. This is a local size heuristic, not a global optimality claim.
5. Merge compatible conjunctions containing only independent `type`, `properties`, `$ref` and `not` keywords. Conflicting values remain in `allOf`. Conditional keywords are never merged across branches. Draft 2020-12 permits siblings of `$ref`.
6. Traverse the reduced graph from its roots. At the first use of a shared node, emit its body with a short relative `$id`, such as `a`. Later uses emit `$ref: "a"`. This removes the separate `$defs` key and the first reference. All resource IDs resolve as siblings under one absolute document namespace. Every resource is embedded in the output file.
7. Keep the file within 32 levels of JSON nesting. Embedding at first use nests resources inside one another, and the invoice would otherwise reach 85 levels. That exceeds the default limit of .NET's System.Text.Json, 64, and networknt's loading time grows steeply with depth: it does not load the invoice within two minutes at 56 levels, but loads the whole corpus in seconds at 32. Bottom up, wherever a subschema would exceed the limit, the tallest subschemas under it move into a root `$defs` and are replaced by `$ref`. A moved resource keeps its `$id`; a moved inline subschema receives a fresh numeric one. Letter names are assigned in declaration order, so an embedded resource's name is never a suffix of the name enclosing it. A number keeps that true for moved pieces, which matters because json-sKema 0.32 ignores an `$id` that its enclosing resource's URI already ends with. Pieces in `$defs` start two levels down, so every piece is held to 30 levels. The invoice moves three subschemas, for 63 bytes; `compile(spec, { maxDepth })` sets another limit.
8. Keep at most 2,000 subschemas between references. Ajv and schemasafe compile each such region into one function, and large coefficients produce wide regions: with 13,000 to 26,000 subschemas in one, Ajv's call stack overflowed while validating some records. Bottom up, wherever a region would exceed the limit, its largest subschemas move into the root `$defs` as in step 7. The four examples have at most 600 subschemas per region, so this moves nothing in them; `compile(spec, { maxSubschemas })` sets another limit.

The optional `defs` layout (`compile(spec, { layout: 'defs' })`, or `--defs`) skips first-use embedding in step 6: every shared resource is declared in root `$defs` and every use is a `$ref`. No resource then sits inside another, which @cfworker/json-schema requires. It costs 17–21% more bytes for the four examples.

Inlining substitutes an acyclic referenced schema at its use sites. The Boolean identities and conjunction merge preserve acceptance, including when Boolean schemas are terminal nodes. Domain-dependent regex simplifications are justified only under the root format checks. These transformations preserve the acceptance condition, not the shape or verbosity of validator diagnostics.

## Compound-schema correctness

A definition body appears at exactly one former reference position. That occurrence applies the same body to the same instance location. Every other reference resolves to its new resource identity, whose body is unchanged apart from recursively applying the same transformation. The reference graph is acyclic, so induction over its dependencies establishes equivalent acceptance.

When the old `$ref` has sibling assertions, the packer conjoins the embedded target through `allOf` instead of merging conditional keywords or overwriting an inner `$id`. Relative IDs are resolved against the document namespace, and all short references resolve to embedded resources. Moving a subschema into `$defs` preserves this: each ID is one relative segment under the same namespace, so a reference resolves to the same resource wherever its enclosing piece sits, and the `$ref` left behind applies the moved body to the same instance location. Tests enumerate resource identities, verify every reference, and load different generated contracts into one registry. The namespace uses a deterministic 64-bit FNV-1a identifier; it is not a security hash or a guarantee against deliberate hash collisions.

## Proof sketch

After processing positions `0..j-1`, write their total signed contribution as `Pⱼ`. The invariant is `Pⱼ = 10ʲ rⱼ`. It is true for `j=0`.

At the next position, `Pⱼ₊₁ = Pⱼ + 10ʲ (Σᵢ cᵢ dᵢⱼ + kⱼ) = 10ʲ sⱼ`. Every unprocessed contribution is a multiple of `10ʲ⁺¹`; therefore a nonzero `sⱼ mod 10` makes total equality impossible. Otherwise `Pⱼ₊₁ = 10ʲ⁺¹ rⱼ₊₁`, preserving the invariant.

At `j=D`, every field is exhausted. Only the high digits of the combined constant remain. The compiler's final condition is therefore equivalent to the complete integer equality. Scaling both sides by the same power of ten preserves the decimal equality.

For an inequality the invariant is that `S ≤ 0` exactly when `Tⱼ ≤ 0`, defined under [State transition](#state-transition). It holds at `j = 0`, where `T₀ = S`, and each ceiling carry preserves it, so the final condition is equivalent to the complete integer inequality.

This argument includes negative carries and negative intermediate totals. In particular, a negative result does not silently wrap to a positive value, and an overflow beyond the input width does not wrap to zero.

## Resource behavior

The generated graph is acyclic: digit tests advance through fields and columns. A selected path reads at most `4DN` predicates for one equation. Multiple equations are conjoined.

Compiled size depends on precision, term count and reachable balances, rather than enumerating every possible complete record. Precision grows the graph by repeating the finite carry-state structure. Field order follows the contract's declaration order. The prototype does not search for a globally optimal variable ordering or packing, leaving room for improvements.

The bound counts graph predicates, not wall-clock instructions. A validator may traverse the schema while compiling, expand references, gather diagnostics, or redo work for annotations. Compound resources save space but increase preparation and resolution costs in the tested validators. Deep resource embedding can also produce large Ajv functions.

For browser preparation, a separate in-memory copy is unbundled: embedded declarations become `$ref` links and each resource is registered at its resolved absolute URI. Each resource is prepared after the resources it embeds or references, using public Ajv APIs. This standard schema transformation adds no arithmetic rule, does not mutate the exported file, and is tested against the entire corpus and a small-stack regression. Stock Ajv and Python's default validator independently check the bundled file without this preparation step.

## Current boundaries

The artifact checks equalities and inequalities. It does not calculate a missing total, modify input data, or infer a value. Negative input strings, `!=`, chained comparisons, products of fields, non-integer coefficients, division and arrays are outside the current source grammar.

The source parser accepts only an explicit grammar of sums and differences of fields, whole-number multiples of fields and decimal constants, related by one of `=`, `<=`, `>=`, `<` and `>`, and never executes source text. Unsupported operators and unknown options are rejected. The generated file is self-contained: every reference resolves to an embedded resource and no network retrieval is needed.

Potential follow-up work should preserve these properties: better variable ordering, per-equation failure messages, per-field bounds, and multiplication by decimal constants with rounding, with explicit size/runtime measurements. The frozen whole-digit compiler and reproducible benchmark provide a baseline for comparing changes without quietly narrowing the domain.
