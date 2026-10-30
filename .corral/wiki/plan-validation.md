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

Task keys must not have the shape of a task ref (`letters-number`, in any
case, such as `COR-4` or `cor-4`). Core returns `key_shaped_like_ref` with a
suggested alternative key, preventing a key from hiding an existing task.
Existing-task refs are matched case-insensitively inside core, including
revision identity, duplicate revision detection, dependency cycles and the
project-wide epic/task graph. Plan keys still match case-sensitively. The
input adapter retains wire trimming and uppercasing for persistence.
