# Demo data

`pnpm dev:demo` starts web and server on a seeded demo, so a new worktree
shows real data at once: two projects, a task in every board column, eight
Inbox items, Plan conversations, PR pages, run transcripts and evidence
screenshots. Data lives in `.corral/demo/server`, apart from `pnpm dev`'s
`.corral/server`. The first start seeds it (about 8 s); `pnpm dev:demo
--reseed` starts over, and `pnpm seed:demo` rebuilds it while nothing runs on it.

**Seeded through the real flows.** `apps/server/src/demo/harness.ts` starts
the server with `boot()` (`src/boot.ts`, the same start as `index.ts` and the
tests) and drives it with `FakeRunner` and `FakeGitHub` (`src/fake-runner.ts`,
`src/fake-github.ts`), the fakes the tests use.
`scenarios.ts` then plays the human, the agents and GitHub step by step. A
task reaches Human review because a fake developer opened a PR and a fake
reviewer approved it, not because a row says so. Every state is one the
server produced, and `seed.test.ts` fails when a flow change breaks the story.

**Time.** `advance('3h')` moves every stored timestamp back by that much, except
leases, which is the same as that much time passing. The story is written
in order and ends at the present. Runs and histories get believable
durations and ages.

**What the demo instance runs.** `CORRAL_DEMO=1` swaps in two stand-ins
(`src/demo/`), loaded only then:
- `DemoGitHub`: the fake GitHub, loaded from and saved to
  `demo-github.json` in the data dir on every write, through
  `FakeGitHub.snapshot()` and `restore()`. Seeded PRs, diffs and CI results
  survive restarts, and Approve really merges. Nothing reaches GitHub.
- A demo runner connects to the server itself. It answers setup jobs and
  takes PM turns only, replying that this is a demo. Developers, designers
  and reviewers are never offered to it, so no agent starts and nothing runs
  `claude`. Work that needs them waits, queued, as it would with a runner
  offline.

**Extending the story.** Keep at most one task runnable at a time. Every
`schedule()` hands all runnable work to the fake runner, and a run nobody
finishes keeps its lease, which the seed checks for at the end. To leave
work waiting, pause the agent or project involved until the story ends, as
`inFlight` does. Screenshots are rendered once from `mockups/` and
`assets/design/` and committed, so seeding needs nothing but Node.
