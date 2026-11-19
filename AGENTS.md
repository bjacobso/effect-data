# Working in effect-data

- **SPEC.md is the current contract.** Any change to observable behaviour
  (wire contract, registry kinds, rule semantics, storage guarantees,
  composition) updates SPEC.md **in the same commit**. Update its "Status"
  line when a pass lands. If code and SPEC.md disagree, fix one of them; do
  not leave both.
- PLAN.md holds the instructions for each pass and is not rewritten after a
  pass lands. REPORT.md records measurements and lessons.
- Conformance suites in `conformance/` are black-box: Effect end to end,
  written as an external client would, importing nothing from `src/`.
- Before finishing: `make test`, then every conformance suite against
  `make run` (and `data.ts` again with `PACKS=onboarding`). Stop any server
  you start.
