# PR-free epic task state (COR-286)

Binding rules: D5, D24, D27, D28 in `docs/decisions.md`; section 4 of
`docs/flows.md`. This is the persistence and negotiation foundation, not the
integration executor rollout.

`tasks.integrationProtocol = 0` preserves all existing paths. The additive
0051 migration changes no branches, PR links, review/evidence rows or epic
modes. `recordTaskSubmission` in `apps/server/src/task-submissions.ts` selects
protocol 1 only for ordinary epic-mode build tasks without PRs, recording a
versioned submission and its base/target atomically. It rejects direct,
standalone, each_task, spike, design and epic conflict submissions.

`task_submissions` records submitted, agent-approved and integrated commits
without a PR FK. Approval must match the submitted head. Integration needs
approval plus a commit and timestamp. `task_integration_operations` journals
expected target SHA, runner, lease epoch and result/error; only one operation
per submission can be active. The executor must write intent before git,
fence the target ref and reconcile unknown results before retrying. Database
constraints protect shape; they do not replace executor authorization, lease
checks or remote confirmation.

Hello's optional `taskIntegrationProtocols` is independent of envelope version
3. Missing means legacy only. Welcome and runner status explain how to update;
claim placement and dispatch both reject unsupported requirements. Current
runners do not advertise protocol 1 until the executor is implemented. Existing
PR work stays available. Do not enable PR-free selection in the old report
handler: it still opens task PRs.

Merged on the PR-free path means confirmed integration into the epic branch;
same-epic dependents can then start. Other dependents wait for the epic PR to
merge. Approval or pending integration never means done. Human review flags
and checked-by-human criteria retain D5/D28 routing before integration.
