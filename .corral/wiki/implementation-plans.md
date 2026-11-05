# Implementation plans

A task has a short `description` for people (what and why) and a separate
`implementationPlan` for agents (approach, files, edge cases, test notes).
Both are rich text on `tasks`; the plan is nullable and existing tasks have none.

- API: `createTaskInput` and `patchTaskInput` take `implementationPlan` as a
  rich-text doc; a PATCH of one field leaves the other alone.
- PM tools: `create_task`, `update_task` and `propose_plan` take it as markdown
  (blank clears it); `get_task` returns it as markdown beside `description`.
- Plans: the field is part of `ProposedTask`, so a revision that changes only
  the plan counts as `changed`, is staged on the revision and applied on
  approval. A revision that leaves it out clears it, as for the description.
- Prompts: role prompts add an `Implementation plan` section after `Task` when
  the plan is non-empty (`taskSections` in `prompts.ts`).
- Web: task detail shows it collapsed under the description and hides it when
  empty (editors get "Add implementation plan"); the plan panel shows each
  proposed task's description with its plan in a closed `<details>`.
