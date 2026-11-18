# Inherited contract

effect-data started inside a larger, multi-language exploration. `PLAN.md`
was written there and refers to an earlier plan for two pieces of contract it
reuses. Those pieces are restated here so this repository stands alone.

## Rule grammar

A rule node is one of:

- `true` or `false`;
- `{ "all": [Rule] }`, `{ "any": [Rule] }` or `{ "not": Rule }` (exactly one
  key, no others);
- a condition `{ "fact", "operator", "value"?, "ignore_case"? }`.

In effect-data, `fact` is an **attribute key** (`namespace/name`), never a dot
path. `operator` is one of `equal`, `notEqual`, `lessThan`,
`lessThanInclusive`, `greaterThan`, `greaterThanInclusive`, `in`, `notIn`,
`contains`, `doesNotContain`, `exists`, `doesNotExist`. `value` is required
except for `exists`/`doesNotExist`, where it must be absent; `in`/`notIn`
take a non-empty array of scalars, every other operator a scalar (never
null). `ignore_case`, when present, is a boolean. Maximum depth is 20.

## Three-valued evaluation

Results are `T`, `F` or `U` (unknown).

- `true` → T, `false` → F; empty `all` → T, empty `any` → F.
- `all`: F if any child is F, else U if any is U, else T.
- `any`: T if any child is T, else U if any is U, else F.
- `not`: T↔F; U stays U.
- A condition on an absent fact: `exists` → F, `doesNotExist` → T, any other
  operator → U.
- Present facts are typed (they were validated against the attribute), so
  there is never string-to-number coercion. Numbers compare numerically,
  strings exactly (or lowercased with `ignore_case`), booleans by value, and
  dates chronologically. `contains` is substring on strings.

## Typed condition checks

A condition is checked statically against the attribute its `fact` names:

- ordering operators apply only to `integer`, `number` and `date`;
- `contains`/`doesNotContain` apply only to `string`;
- `ignore_case` applies only to `string` and `enum`;
- operands must have the attribute's type, except that `integer` and `number`
  attributes accept any finite number (`level lessThan 20.5` is valid); an enum
  operand must be one of the enum's `values`.

## Value encoding

| Type | Encoding |
| --- | --- |
| `string` | JSON string of 0 to 10,000 code points |
| `integer` | JSON number that is an integer in the safe range |
| `number` | finite JSON number |
| `boolean` | JSON boolean |
| `date` | `"YYYY-MM-DD"`, a real calendar date |
| `enum` | one of the attribute's `values` |

Absent and `null` both mean "no value". Error paths use dots for keys and
`[i]` for indexes, reported at the property that is wrong, with duplicates
reported on the later occurrence.
