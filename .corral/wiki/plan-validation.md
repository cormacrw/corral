# Plan validation and revision equality

`packages/core/src/plan.ts` validates each proposed task with the same
`checkDefinitionOfReady` function used for stored task content. Each Ready
problem carries the proposed task's key. Graph, ref and design validation
remain additional plan checks.

Plan revisions compare every `ProposedTask` field through a required typed
comparison map. Adding even an optional field requires an equality rule.
Dependencies and design screens use unordered multiset equality: order is
ignored, but duplicate counts are preserved, so replacing `['a', 'a']` with
`['a', 'b']` is a change. Acceptance criteria remain ordered. Design refs
remain case-insensitive and absent/empty epic values remain equivalent.
