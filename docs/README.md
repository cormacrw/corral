# Corral docs

Reference material for agents building Corral. Read this file first.

## Files

| File | What it is | Binding? |
|---|---|---|
| [decisions.md](decisions.md) | Decisions made after the PRD was written. These override the PRD (e.g. D19: task types are Task, Bug and Spike, and evidence follows the acceptance criteria; D20: Design tasks deliver versioned, sandboxed prototypes that the human approves before the build is planned; D21: checks are gates, human evidence judges criteria and may be note-only; D23: designers own design tasks, with separate instructions and new sessions for work previously run by developers; D27: epics have review modes, and their tasks reach an epic branch, by a task PR or, for PR-free submissions, by Corral integrating the approved commit, and the epic PR is the only way their work reaches the target branch, with Corral rebasing epics automatically at checkpoints and sending conflicts to a developer and reviewer (COR-290), and approval crossing a rebase only when the journal and review validate it, with product choices asked in Needs you (COR-291); D24: approved task PR conflicts use rebase-only rounds where the developer marks the resolution trivial or needs_review, a server check can carry over approval for a trivial one without a reviewer, and a rebase review otherwise carries over approval, requests changes or blocks on a substantial change; D26: reviewers review the code and leave the gates to required CI, running them without the cache only when a project has none; D28: criteria checked by a human skip agent evidence and verdicts and route approval to Human review, except PR-free epic tasks, whose human checks wait for the epic's final human approval). | **Yes** |
| [architecture.md](architecture.md) | Processes, repo layout, stack, runner implementation rules, resource estimates (D7). | **Yes** |
| [flows.md](flows.md) | Walkthroughs: talking to the PM, a task from Ready to Merged, failure handling, an epic from its first task to its epic PR merging. | **Yes** |
| [prd.md](prd.md) | The MVP Product Requirements Document (v1.0, 2026-10-26). | **Yes**, except where `decisions.md` overrides it |
| [design/](design/README.md) | Page-by-page UI specs for the web app, matching the design canvas. | **Yes** for UI, except where `decisions.md` overrides it |
| [agent-runtime-and-auth.md](agent-runtime-and-auth.md) | How Corral runs the AI agents (Claude Code and Codex), the auth/terms background, and the rules that keep the runtime swappable. | **Yes** (its rules follow from D2 and D18) |
| [stale-runners-and-fencing.md](stale-runners-and-fencing.md) | Plain explanation of the stale-runner problem and how leases, fencing tokens and scoped GitHub tokens solve it. | Background. Its POC suggestions are advisory, like `open-recommendations.md` (R10) |
| [open-recommendations.md](open-recommendations.md) | Review feedback on the PRD that hasn't been accepted or rejected yet, including known inconsistencies. | **No.** Raise these with Cormac before acting on them |

[Runner-only deployment on WSL2](runner-wsl2.md) is the operator guide for a remote gaming-PC runner (D25).

## Precedence

1. `decisions.md`
2. `architecture.md`, `flows.md`, `prd.md` and `agent-runtime-and-auth.md`
3. `open-recommendations.md` (advisory only)

If two binding documents conflict and the precedence order doesn't settle it, stop and ask. Don't pick one yourself.

## Current phase

We are building a **local-only proof of concept** for a single user (Cormac), running agents on the user's own Claude and ChatGPT subscriptions through their CLIs. See D1, D2 and D18 in `decisions.md`. It's developed on the laptop and deployed as Docker containers on the user's home server, behind a Cloudflare Tunnel and Cloudflare Access (D12). Hosted, multi-user and sellable concerns are deferred, but the architecture must not make them hard to add later.
