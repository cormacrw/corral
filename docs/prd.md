# Corral — MVP Product Requirements Document

> **For agents:** This is the PRD as written. Decisions made afterwards are in [decisions.md](decisions.md) and **override this document** where they conflict. Most importantly, the POC is local-only (D1) and uses the user's own locally authenticated agent CLI (D2). Known inconsistencies in this document are listed in [open-recommendations.md](open-recommendations.md#inconsistencies-in-the-prd).

| | |
|---|---|
| **Version** | 1.0 |
| **Date** | October 26, 2026 |
| **Status** | Proposed |
| **Product** | Corral |
| **Primary interface** | Web application |
| **Execution environment** | Local runner on the user's computer |

## 1. Overview

Corral is an AI-powered engineering team managed through a conversational Product Manager (PM).

The human describes what they want to build. The PM helps refine the idea, asks clarifying questions, and proposes an implementation plan consisting of concrete tasks with acceptance criteria and dependencies. Once approved, autonomous coding agents execute those tasks, open pull requests, review changes, verify evidence, and merge eligible work.

The primary interaction is the PM conversation. The task board, agent activity, pull requests, and project wiki support that interaction rather than replacing it.

Corral consists of three core components:

- **Product management layer:** A conversational PM that understands the product and turns ideas into executable tasks.
- **Engineering control plane:** A persistent task system, scheduler, locking mechanism, review workflow, and merge orchestrator.
- **Execution layer:** Local coding agents running in isolated Git worktrees, with an architecture that allows cloud containers to replace local execution later.

### 1.1 Problem

Using multiple coding agents requires a human to coordinate every step: writing tickets, starting sessions, assigning work, checking progress, reviewing PRs, requesting fixes, resolving conflicts, and merging changes.

The human becomes the scheduler and bottleneck.

Corral makes the task board the operational source of truth and the PM the primary interface. The PM manages planning, while deterministic infrastructure manages execution, permissions, review gates, and merging.

### 1.2 Product vision

> Describe the outcome. Approve the plan. Review what gets delivered.

Corral should let a developer delegate increasingly large portions of the engineering workflow without sacrificing visibility, quality, or control.

### 1.3 Target user

The initial user is an individual developer or technical founder who:

- Owns one or more code repositories.
- Uses AI coding agents.
- Wants to delegate multiple independent engineering tasks.
- Prefers describing desired outcomes over manually managing tickets.
- Wants to review working software rather than supervise every agent interaction.

The MVP is single-user. Multi-user team collaboration is outside its initial scope.

## 2. Product principles

- **Conversation first.** The PM is the primary interface for describing, refining, and planning work.
- **The board is the operational source of truth.** Task state, dependencies, assignments, locks, and outcomes are persisted and auditable.
- **The code is the source of truth for implementation.** Technical documentation lives in the repository and is maintained by coding agents as they change the code.
- **Evidence is part of delivery.** Every completed task must provide evidence appropriate to its type.
- **Automation should be deterministic wherever possible.** Code enforces scheduling, permissions, locking, and merge eligibility. Models handle planning, implementation, and review.
- **Execution is replaceable.** Local runners and future cloud containers implement the same execution contract.
- **The human remains in control.** Work requires approval before execution, designated changes can require human review, and the user can pause or stop the system.
- **No unnecessary agent sessions.** Cheap scheduler checks determine whether work exists before spending tokens.
- **One task, one branch, one PR.** Every task has an isolated implementation and review lifecycle.
- **Knowledge improves over time.** Completed work keeps the repository wiki aligned with the implementation.

## 3. Goals and non-goals

### 3.1 Goals

The MVP must:

- Turn a conversation with the PM into an approved, structured implementation plan.
- Automatically execute eligible tasks without manual agent startup.
- Support isolated coding-agent workspaces on the user's computer.
- Automatically open and update GitHub PRs.
- Support independent review, requested changes, and bounded review rounds.
- Require evidence and configured CI checks before merging.
- Automatically merge eligible PRs.
- Maintain technical documentation in the repository alongside code changes.
- Give the human clear visibility and control over every active run.
- Recover safely from interrupted runs, expired locks, and failed agents.
- Use one stable control plane that can support local or cloud execution.
- Keep idle scheduling inexpensive by avoiding unnecessary LLM calls.

### 3.2 Non-goals

The MVP will not include:

- Multi-user organizations or shared hosted workspaces.
- Multiple repositories per project.
- Cloud-based coding-agent execution.
- A dedicated tester agent group.
- Mobile applications or remote phone control.
- Integrations with Linear, Jira, Trello, or other project trackers.
- PM-authored canonical technical documentation.
- A full-featured wiki platform with advanced semantic search.
- A general-purpose task management system for non-engineering teams.
- Advanced agent budgets and usage analytics.
- Automated deployment to production.
- Autonomous PM approval of its own proposed work.
- General-purpose visual workflow builders or custom gate scripting.

## 4. Core product model

### 4.1 Project

A project represents one Git repository.

Fields:

- Project ID
- Name and description
- Repository URL
- Default branch
- GitHub configuration
- Merge method
- Required CI checks
- Agent group configuration
- Runner registration
- Pause state
- Created and updated timestamps

### 4.2 Epic

An epic groups related tasks around a feature or product outcome.

Fields:

- ID
- Title
- Description
- Priority
- Status derived from its tasks
- Linked tasks
- Created by
- Created and updated timestamps

### 4.3 Task

A task is the unit of work that becomes one PR. (A Design task becomes an approved design version instead, D20.)

Fields:

- ID
- Title
- Description
- Acceptance criteria
- Status
- Priority
- Epic ID
- Dependencies
- Task type: Task, Bug, Spike or Design (D19, D20)
- Human review flag
- Lock and active run reference
- Branch name
- PR URL and ID
- Evidence packets
- Review rounds
- Comments
- Run history
- Retry counters
- Created by
- Created and updated timestamps

Each acceptance criterion must be individually verifiable.

### 4.4 Agent group

An agent group represents a role and its execution configuration.

MVP groups:

- Developer
- Reviewer

Configuration:

- Role
- Maximum concurrent runs
- Wake interval
- Model and runtime configuration
- Role instructions
- Paused state
- Retry and review caps

The PM is a conversational service, not a continuously polling worker.

### 4.5 Agent run

A run represents one agent session working on one task.

Fields:

- Run ID
- Group and role
- Task ID
- Runner ID
- Start and end times
- Run state
- Token or cost metrics where available
- Transcript and logs
- Outcome
- Error details

A run is distinct from a task. A task may have multiple runs over its lifecycle.

### 4.6 Lock

A lock is a lease that grants a run exclusive execution rights over a task.

Fields:

- Task ID
- Holder run ID
- Role
- Acquisition time
- Expiration time
- Last heartbeat

Claims must be atomic. Expired locks can be reclaimed after run reconciliation.

### 4.7 Comment

Comments provide task-specific communication between the human and agents.

Fields:

- Task ID
- Author and role
- Body
- Timestamp
- Optional linked review, CI failure, or test report
- Optional pinned flag

Agents must read pinned comments before implementing or revising a task.

## 5. Task lifecycle

### 5.1 Statuses

> **Superseded by D10:** statuses are Backlog, Ready, In progress, Agent review, Human review, Merged, Blocked, Failed. No Testing, no Cancelled. §5.1 and §5.2 below are kept for history; the transitions in [decisions.md](decisions.md#d10--task-statuses-and-transitions) are binding.

| Status | Meaning |
|---|---|
| Needs refinement | The task is unclear or too large to implement safely |
| Ready | Approved, sufficiently specified, and eligible for execution |
| In progress | A developer run owns the task |
| In review | A PR is open and awaits review |
| Testing | Reserved for a future dedicated tester group |
| Human review | Agent gates passed, but explicit human approval is required |
| Merged | The PR has been merged successfully |
| Blocked | Execution cannot safely continue without human intervention |

Testing is reserved in the model but does not require a dedicated agent group in the MVP.

### 5.2 Permitted transitions

- New tasks start in Needs refinement or Draft within the PM planning workflow.
- Only the human can approve a proposed task plan for execution.
- Approved tasks enter Ready when all dependencies are Done.
- The developer gate claims a Ready task and moves it to In progress.
- Opening or updating a PR moves the task to In review.
- Requested changes return the task to In progress.
- Reviewer approval moves the task to Human review if human approval is required; otherwise it makes the task eligible for automated merge.
- CI failures return the task to In progress with the failure details attached.
- Retry caps, review caps, explicit agent escalation, or unrecoverable errors move the task to Blocked.
- A human can approve a task in Human review or request changes.
- Successful orchestrator merge moves the task to Merged.
- Merged tasks are immutable history. Follow-up work creates a new task.

Status transitions are enforced by the backend, not by agent instructions alone.

### 5.3 Definition of Ready

A task can enter Ready only when:

- A human has approved the task or plan.
- The title and description are sufficiently clear.
- Acceptance criteria are present and verifiable.
- Dependencies are complete.
- The task is small enough to produce one independently reviewable PR.
- Required repository and runner configuration is available.

### 5.4 Definition of Done

A task is Done when:

- Its PR has been merged.
- The reviewer has approved the implementation.
- Required CI checks passed.
- Required evidence is present.
- Required documentation changes are included.
- Any human-review requirement has been satisfied.

## 6. Primary user journey

The complete MVP workflow is:

1. The user describes a desired feature to the PM.
2. The PM reads relevant project context, wiki pages, existing tasks, and repository information.
3. The PM asks clarifying questions.
4. The PM proposes an implementation plan with tasks, dependencies, priorities, and acceptance criteria.
5. The user reviews, edits, and approves the plan.
6. Approved tasks with completed dependencies enter Ready.
7. The scheduler detects eligible work and atomically claims a task.
8. A local runner starts a developer session in an isolated Git worktree.
9. The developer implements the task, runs checks, updates relevant documentation, and gathers evidence.
10. The developer opens or updates the task's GitHub PR.
11. The reviewer checks the diff, acceptance criteria, tests, evidence, and documentation.
12. If changes are required, the task returns to the developer for another review round.
13. Once approved, the orchestrator waits for required CI checks and validates all merge gates.
14. If the task requires human review, the task enters Human review.
15. Otherwise, the orchestrator merges the PR.
16. The task becomes Merged and its history is preserved.
17. The PM summarizes what was delivered, links the PR and evidence, and identifies relevant follow-up work.

The system must also support failure, retry, cancellation, and recovery at each applicable stage.

## 7. Functional requirements

### 7.1 Project setup

**Goal:** Connect a repository and prepare it for autonomous work.

Requirements:

- Users can create a project and connect one Git repository.
- Users configure the default branch, merge method, required CI checks, and runner.
- Corral verifies Git, runtime availability, credentials, and repository access.
- Corral initializes `.corral/` files where needed without overwriting existing user content.
- The app reports runner readiness and connectivity.
- The app warns about incompatible repository state and configuration.
- The user can pause the entire project.

Acceptance criteria:

- A project cannot start work until setup checks pass.
- The runner can access the configured repository.
- A second Corral instance cannot silently schedule against the same repository under the MVP's repository ownership mechanism.

### 7.2 PM conversation

**Goal:** Make the PM the main way to plan work.

Requirements:

- Persistent PM conversation per project.
- PM reads project metadata, task state, relevant wiki pages, repository instructions, and recent execution outcomes.
- PM asks questions when requirements are ambiguous.
- PM creates structured draft epics and tasks.
- PM identifies dependencies and oversized tasks.
- PM proposes priorities and implementation order.
- Users can edit individual tasks and acceptance criteria.
- Users can revise the plan through conversation.
- Proposed changes are displayed as structured UI elements.
- The human explicitly approves the plan before tasks enter Ready.
- PM explains task progress, blockers, review outcomes, and delivery summaries.

Restrictions:

- The PM cannot merge PRs.
- The PM cannot bypass role permissions or locks.
- The PM cannot approve its own proposed plan.
- The PM cannot directly modify canonical implementation documentation.

Acceptance criteria:

- A natural-language request produces a structured, editable task plan.
- Each task has verifiable acceptance criteria.
- Dependencies are persisted and respected by the scheduler.
- Unapproved tasks cannot execute.
- PM answers use current project state rather than relying exclusively on conversation history.

### 7.3 Board and task management

**Goal:** Maintain one authoritative representation of work.

Requirements:

- Kanban board grouped by status.
  > **D10:** Backlog tasks are not on the board; they have their own Backlog view in the main navigation.
- Filtering by epic, status, priority, and agent.
- Task cards display priority, dependency state, lock status, active agent identity, and PR status.
- Task detail shows description, acceptance criteria, comments, dependencies, evidence, PR, reviews, and run history.
- Humans can edit a locked task.
- Editing acceptance criteria or description during execution posts a message to the active agent.
- The system records all changes with actor and timestamp.
- The UI and agents use the same validated core operations.
- Invalid status changes are rejected by the backend.

Acceptance criteria:

- UI state is derived from persisted task state.
- Concurrent updates do not silently overwrite each other.
- Humans can see why a task is blocked or waiting.

### 7.4 Local runner and workspace management

**Goal:** Execute coding agents locally while preserving a portable execution architecture.

Requirements:

- The local runner securely registers with the hosted control plane.
- It accepts authorized jobs over an authenticated connection.
- It creates a separate Git worktree and branch for each task.
- It launches the configured agent runtime.
- It streams logs and structured run events to Corral.
- It supports input, interruption, stop, and safe cleanup.
- It preserves branches, commits, PRs, and evidence across interruption.
- It reports runner health and job outcomes.
- It enforces execution time limits.
- It reconciles interrupted or expired runs before taking new work.
- It supports one initial operating system, with a portable protocol and no OS-specific assumptions in the core task model.

Acceptance criteria:

- Concurrent tasks never share a writable worktree.
- A task cannot have two active developer runs.
- Lost runner connections eventually trigger reconciliation.
- Interrupted runs are distinguished from failed runs.
- Workspace cleanup never destroys uncommitted work without an explicit safe policy.

### 7.5 Developer agent

**Goal:** Turn a Ready task into a reviewable PR.

Requirements:

- The scheduler wakes developers only when eligible work exists.
- The developer receives the task, acceptance criteria, relevant wiki context, repository instructions, and pinned comments.
- It implements the task in its assigned worktree.
- It runs configured lint, type checks, tests, and build checks.
- It updates relevant repository documentation in the same branch.
- It produces task-type-specific evidence.
- It opens or updates exactly one PR for the task.
- It responds to review feedback on the same branch and PR.
- It reports a structured outcome to the orchestrator.

Developers cannot:

- Approve their own PRs.
- Merge their own PRs.
- Change task state outside permitted transitions.
- Work on tasks they do not hold a valid lock for.

Acceptance criteria:

- A Ready task can produce a real PR without manual session startup.
- PRs link to the originating task.
- Required checks and evidence are recorded.
- Developer completion alone never triggers a merge.

### 7.6 Reviewer agent

**Goal:** Independently verify changes and bound review loops.

Requirements:

- Reviewer wakes for PRs requiring review, new commits, or required rebases.
- Reviewer evaluates code against acceptance criteria.
- Reviewer checks test results, evidence, and relevant documentation.
- Reviewer returns an explicit approval or requests changes with actionable feedback.
- Reviewer rebases branches when safe.
- Trivial conflicts may be resolved; non-trivial conflicts return to the developer.
- Reviewer cannot implement feature changes or merge PRs.
- Review rounds are capped, with a default of five.
- Repeated substantially identical feedback can trigger escalation.

Acceptance criteria:

- Every review has a recorded verdict and rationale.
- Changes requested return the task to In progress.
- New commits invalidate approvals when required by the configured review policy.
- Exhausting the review cap blocks the task and notifies the human.

### 7.7 Review evidence

**Goal:** Prove that each task meets its acceptance criteria.

Evidence is a mandatory deliverable.

**Overridden by D19:** evidence follows each acceptance criterion, not the task type. The kinds below are guidance for choosing it.

**Amended by D21:** lint, typecheck, tests and build are gates, never criterion evidence. The test results and CI results below are agent artifacts kept for review and debugging, collapsed in the UI. Human evidence is screenshots/video, real requests/responses, before/after metrics and the reviewer's per-criterion note. A criterion with nothing visual to show may use a written explanation without a file; the reviewer judges it and its verdict note is the proof. See [D21](decisions.md#d21--evidence-is-for-judging-criteria-checks-are-gates).

| Kind of change | Evidence |
|---|---|
| Visible (UI) | Screenshots of relevant acceptance criteria, viewport details, test results |
| API | Real example requests and responses for changed endpoints, relevant error cases, test results |
| Both | Applicable UI and API evidence |
| Internal (infrastructure, refactor) | Test and CI results, relevant before/after metrics, risk notes |

Each review packet contains:

- Plain-English summary.
- Acceptance criteria with pass/fail status.
- Supporting evidence for each criterion.
- Test and CI results.
- Known limitations.
- Reviewer verdict and rationale.

Requirements:

- Evidence is stored durably and associated with the task and review round.
- Evidence survives force-pushes, closed PRs, and workspace cleanup.
- The reviewer checks evidence against acceptance criteria.
- Missing required evidence blocks approval or merge.
- The human review screen presents criteria alongside supporting evidence.

The MVP does not require a dedicated tester group. Developers produce the evidence and reviewers verify it.

### 7.8 Scheduling and locking

**Goal:** Avoid unnecessary agent sessions and prevent duplicate work.

Requirements:

- Each agent group has a concurrency limit, wake interval, runtime configuration, and pause setting.
- A lightweight scheduler checks for eligible work without invoking an LLM.
- Events such as task approval and PR pushes can trigger an immediate gate check.
- The scheduler claims tasks atomically.
- Locks use leases and heartbeats.
- The orchestrator applies status transitions and releases locks.
- Expired runs are reconciled before tasks become available again.
- Retry and review caps move tasks to Blocked.
- The project supports pause, resume, and kill-switch controls.

Suggested initial defaults:

| Setting | Default |
|---|---|
| Developer concurrency | 1 |
| Reviewer concurrency | 1 |
| Lease duration | 15 minutes |
| Heartbeat interval | 2 minutes |
| Review-round cap | 5 |
| Failed-run cap | 3 |
| Automatic merge | Configurable |
| Required CI checks | Explicitly configured |

Acceptance criteria:

- Zero double-claimed tasks.
- Idle scheduler checks start no agents.
- Failed or interrupted runs cannot permanently hold tasks.
- Stale runners cannot continue to act as authorized task owners after losing their lease.

### 7.9 Pull requests and merge orchestration

**Goal:** Deliver changes automatically without bypassing quality gates.

Requirements:

- Corral creates and updates PRs through GitHub.
- Each PR links to its task and review packet.
- Corral tracks review state, CI, branch freshness, and mergeability.
- Reviewer approval is independent of developer completion.
- The orchestrator merges only when all required conditions pass:
  - Valid reviewer approval.
  - Required CI checks pass.
  - Required evidence is present and validated.
  - The task is not Blocked or cancelled.
  - Human review is not outstanding.
  - The PR is mergeable against the current base branch.
- Pending CI waits without repeatedly waking agents.
- Failing CI returns the task to In progress with failure output attached.
- Rebase conflicts follow reviewer/developer handoff rules.
- Merge outcomes and commit references are recorded.
- Cancellation closes the PR and removes the Corral branch when safe, then archives the task.

Acceptance criteria:

- Eligible Ready tasks can be merged without manual intervention.
- Tasks requiring human review cannot auto-merge.
- The orchestrator independently verifies gates before merging.
- Merge failure never incorrectly marks a task Merged.

### 7.10 Repository wiki and technical knowledge

**Goal:** Maintain accurate implementation knowledge shared by the PM and coding agents.

The wiki lives in the repository as Markdown. It describes what the implementation actually does, not merely what the team intends to build.

Suggested structure:

```text
.corral/
├── CORRAL.md
├── wiki/
│   ├── index.md
│   ├── architecture.md
│   ├── data-model.md
│   ├── api-reference.md
│   ├── frontend-structure.md
│   ├── testing.md
│   └── decisions/
│       └── 001-runner-architecture.md
└── agents/
    ├── pm/AGENT.md
    ├── developer/AGENT.md
    └── reviewer/AGENT.md
```

Requirements:

- `CORRAL.md` is the short context entry point for agents.
- Wiki pages document architecture, interfaces, behavior, conventions, and decisions.
- PM has read access to canonical technical documentation.
- PM does not directly rewrite canonical implementation documentation.
- Developers read relevant pages before implementation and update affected pages within the same PR.
- Reviewers verify that documentation matches the implementation.
- The PM can flag stale documentation and create a documentation-maintenance task.
- Source code and executable tests remain authoritative if the wiki conflicts with reality.
- Superseded architectural decisions are marked rather than silently erased.

Acceptance criteria:

- Relevant implementation changes include corresponding documentation updates, or an explicit explanation of why none are needed.
- The wiki is versioned with the code.
- All agent roles can read and search it through shared operations.

MVP search can use full-text search and Markdown links. Vector search and automated knowledge graphs are deferred.

### 7.11 Human controls and visibility

Required views:

**PM chat**
- Persistent conversation.
- Clarifying questions and proposed plans.
- Editable task cards.
- Approval actions.
- Delivery summaries.

**Board**
- Tasks grouped by status.
- Filters and epic grouping.
- Agent identity, lock, dependency, and PR indicators.

**Task detail**
- Description and acceptance criteria.
- Comments and pinned guidance.
- PR and diff links.
- Evidence and review rounds.
- Run history and failure output.

**Agents**
- Active runs.
- Role, task, elapsed time, and available usage data.
- Live output.
- Attach, interrupt, and stop controls.

**Pull requests**
- PR state.
- Review verdict.
- CI status.
- Rebase status.
- Evidence completeness.
- Merge eligibility.

**Human queue**
> **Superseded by D11:** this is the **Inbox**: developer and reviewer items only. PM questions and plan approvals stay in Plan.

- Tasks requiring human review.
- Blocked tasks.
- PM questions and unresolved decisions.

**Control panel**
- Concurrency and wake intervals.
- Group pause/resume.
- Global pause.
- Kill switch.
- Merge configuration.

Requirements:

- Finished runs open read-only.
- The UI explains why work is waiting or blocked.
- Notifications alert the human to Blocked tasks and pending decisions.
  > **D11:** no separate notifications feed. The Inbox covers Blocked tasks and reviews; the Plan nav item shows an unread dot for PM messages.
- Every manual override is recorded in the audit history.

## 8. Technical architecture

### 8.1 Architecture overview

Corral uses a hosted control plane and a local execution plane.

> **POC note (D1):** The control plane runs locally for the POC, as a separate process talking to the runner over the same protocol.

```text
┌──────────────────────────────────────────┐
│              Web application             │
│ PM chat · Board · Agents · Human queue   │
└────────────────────┬─────────────────────┘
                     │ HTTPS / SSE
┌────────────────────▼─────────────────────┐
│             Hosted control plane         │
│                                          │
│ API · PostgreSQL · Scheduler             │
│ Task lifecycle · Locks · Policy engine   │
│ GitHub integration · Merge orchestrator  │
└────────────────────┬─────────────────────┘
                     │ Authenticated outbound connection
┌────────────────────▼─────────────────────┐
│              Local runner                │
│                                          │
│ Git worktrees · Agent runtime · Tests    │
│ Logs · Artifacts · Process management    │
└────────────────────┬─────────────────────┘
                     │
┌────────────────────▼─────────────────────┐
│                 GitHub                   │
│ Branches · PRs · Reviews · CI · Merge    │
└──────────────────────────────────────────┘
```

### 8.2 Recommended stack

> **Superseded by D7:** Nuxt + Nuxt UI (not SvelteKit), Hono server, PGlite → Postgres, Node/TS runner, Turborepo. See [architecture.md](architecture.md).

| Component | Recommendation |
|---|---|
| Frontend | SvelteKit and TypeScript |
| Backend | TypeScript API service with clear module boundaries |
| Database | PostgreSQL |
| Scheduler | Lightweight worker with database-backed scheduling |
| Local runner | Rust or Node.js, selected once for the MVP |
| Agent runtime | Claude Code CLI adapter (Codex CLI added by D18) |
| Workspace isolation | Git worktrees |
| Git provider | GitHub App or appropriately scoped credentials |
| Evidence storage | S3-compatible object storage |
| Live updates | Server-sent events or WebSockets |
| Agent tool access | Shared API, CLI, and MCP adapter |
| Authentication | Hosted user authentication and revocable runner credentials |

### 8.3 Architectural boundaries

The following boundaries are mandatory:

- The control plane owns task state, locks, role permissions, and merge eligibility.
- The runner executes authorized jobs but cannot independently change a task to Merged.
- The agent runtime is independent of the machine or container running it.
- Repository workspaces are managed through a workspace abstraction.
- Evidence storage is independent of the runner filesystem.
- The scheduler does not contain machine-specific execution logic.
- All task state changes pass through validated backend operations.
- External tracker integrations can be added later through adapters without changing agent-facing task operations.

### 8.4 Runner contract

Define a stable provider interface before implementing execution.

```ts
interface RunnerProvider {
  provision(job: RunJob): Promise<RunnerHandle>;

  start(
    handle: RunnerHandle,
    job: RunJob
  ): Promise<void>;

  sendInput(
    handle: RunnerHandle,
    message: string
  ): Promise<void>;

  stop(handle: RunnerHandle): Promise<void>;

  destroy(handle: RunnerHandle): Promise<void>;
}
```

The local implementation uses Git worktrees and local processes. A future cloud implementation can create ephemeral containers while satisfying the same contract.

Keep `AgentRuntime` separate from `RunnerProvider`. Claude Code should be able to run locally or in a cloud container without changing the task model.

### 8.5 Portable job specification

A job must not depend on a machine-specific filesystem path or process ID.

Example:

```ts
interface RunJob {
  taskId: string;
  repositoryId: string;
  baseBranch: string;
  branchName: string;
  agentRole: "developer" | "reviewer";
  acceptanceCriteria: string[];
  timeoutSeconds: number;
}
```

The runner resolves repository IDs and creates the appropriate workspace.

### 8.6 Run lifecycle

Each run has one of the following states:

- Queued
- Starting
- Running
- Waiting for input
- Stopping
- Completed
- Failed
- Interrupted

The agent finishes a run by reporting a structured outcome, such as:

- `pr_opened`
- `pr_updated`
- `approved`
- `changes_requested`
- `stuck`
- `failed`

> **Note (D3):** add a `rate_limited` outcome for usage-limit exhaustion. It is not a failure.

The orchestrator validates the outcome, applies the permitted status transition, and releases the lock.

If a session ends without reporting an outcome, it receives one opportunity to finish correctly before the run is treated as failed. An actively attached human session must not be marked failed merely for going quiet.

## 9. Security and reliability

Corral executes code and interacts with repositories, so these controls are part of the MVP.

### 9.1 Security

- All operations are authorized server-side.
- Runner enrollment uses secure pairing and revocable credentials.
- GitHub permissions are restricted to the necessary repositories and operations.
- Long-lived credentials are never inserted into model prompts or committed to worktrees.
- Agent-generated shell commands and repository scripts are treated as untrusted.
- Local execution trust boundaries are explicit to the user.
- Worktrees and processes are isolated per run.
- Agents cannot modify tasks outside their permitted write scope.
- Status transitions are enforced in the backend.
- Merge gates are checked independently of agent claims.
- Secrets are stored using appropriate secret-management mechanisms.

### 9.2 Reliability

- Atomic task claims prevent double assignment.
- Leases expire when a runner stops heartbeating.
- Orphaned runs are reconciled before scheduling resumes.
- Interrupted runs are not counted as genuine failures.
- Retry limits prevent infinite loops.
- Workspace cleanup preserves uncommitted work and evidence.
- GitHub state is reconciled after reconnecting.
- Merge operations are idempotent or safely reconciled after ambiguous failures.
- Audit history records status changes, claims, review decisions, and merges.

### 9.3 Shutdown behavior

When the local runner shuts down:

1. Stop accepting new jobs.
2. Request graceful termination of active runs.
3. Wait up to five seconds before terminating remaining processes.
4. Mark affected runs Interrupted, not Failed.
5. Release or invalidate their leases through the control plane.
6. Preserve branches, commits, PRs, and evidence.
7. Reconcile state before resuming work on reconnect.

The hosted scheduler must not assume that a disconnected runner is immediately safe to reuse. Stale processes must lose authorization to perform further work. (See [stale-runners-and-fencing.md](stale-runners-and-fencing.md).)

## 10. Failure handling

| Failure | Expected behavior |
|---|---|
| Developer process crashes | Mark run failed after reconciliation, release lock, retry within cap |
| Runner disconnects | Detect missing heartbeat, expire lease, reconcile before retry |
| App or runner shuts down | Stop runs gracefully and mark them Interrupted |
| CI fails | Attach output, return task to In progress |
| Reviewer requests changes | Attach feedback and return task to In progress |
| Review-round cap reached | Block task and notify human |
| Failed-run cap reached | Block task and notify human |
| Rebase conflict | Resolve trivial conflicts or hand back to developer |
| Non-trivial implementation ambiguity | Escalate to Blocked |
| Evidence missing | Prevent approval or merge |
| Human review required | Wait in Human review |
| GitHub merge fails | Reconcile PR state and retry only if safe |
| Task cancelled | Stop run, close PR, clean branch when safe, archive task |
| Runner resumes after lease expiry | Reject stale task operations and reconcile its state |
| Usage limit reached *(added, D3)* | Pause the agent group until reset; not counted as a failure |

The system must never assume that an agent's reported success is sufficient proof of successful delivery.

## 11. Cost controls

The MVP should prove value without requiring substantial infrastructure spending.

Requirements:

- The scheduler does not use LLM calls to discover whether work exists.
- Idle groups consume no agent tokens.
- Concurrency defaults to one developer and one reviewer.
- Each run has a configurable timeout.
- Retry and review caps limit repeated work.
- Agent models are configurable by group.
- The user can stop all active runs immediately.
- Token and cost metrics are recorded when the runtime makes them available.
- Pending CI and review events do not cause repeated polling sessions.
- Workspaces are cleaned up when safe.
- Cloud compute is not required for the MVP.

The local runner uses the user's computer for execution. This reduces infrastructure costs but does not eliminate model-provider costs, subscription restrictions, storage costs, or hosted control-plane costs.

The chosen agent authentication method must comply with the provider's supported usage and commercial terms. (See [agent-runtime-and-auth.md](agent-runtime-and-auth.md).)

## 12. User experience and design requirements

Corral should feel like a premium developer tool: functional, information-dense, clear, and understated.

The PM conversation is the home screen. The board and operational views are secondary navigation.

### 12.1 Design principles

- Conversation-first navigation.
- Clear visual distinction between proposed, approved, executing, and completed work.
- Compact, readable task cards.
- Strong visibility into agent activity without overwhelming the user with logs.
- Clear explanations for blocked tasks and failed gates.
- Review screens organized around acceptance criteria and evidence.
- Consistent controls for pause, stop, approve, and request changes.
- Responsive layouts for the primary web application.
- Explicit loading, empty, disconnected, and failure states.

### 12.2 Required views

**PM chat**
- Persistent project conversation.
- Clarifying questions.
- Structured plans and editable task cards.
- Dependency visualization where useful.
- Approve-plan action.
- Delivery summaries and follow-up suggestions.

**Board**
- Kanban by status.
  > **D10:** approved work only. Backlog tasks live in a separate Backlog view.
- Epic and priority filters.
- Lock and agent indicators.
- Dependency and PR status.

**Task detail**
- Description and acceptance criteria.
- Comments and pinned instructions.
- PR link.
- Evidence packets.
- Review history.
- Run history and failure details.

**Agents**
- Live runs and task assignment.
- Elapsed time and usage metrics.
- Transcript tail and tool activity.
- Attach, interrupt, stop, and pause controls where supported.

**Pull requests**
- Review status.
- CI and rebase state.
- Evidence completeness.
- Merge eligibility and waiting reasons.

**Human queue**
> **Superseded by D11:** the **Inbox**. Plan approvals and PM questions live in Plan, not here.

- Tasks awaiting approval.
- Blocked tasks.
- PM questions.
- Failed or escalated work.

**Project control panel**
- Agent concurrency.
- Wake intervals.
- Pause/resume.
- Global pause.
- Kill switch.
- Merge settings and required checks.

## 13. Build phases

The implementation should proceed in vertical slices, validating the end-to-end workflow early.

### Phase 1 — Foundation

Build:

- Project and repository model.
- Database and task lifecycle.
- Dependencies and comments.
- Actor attribution and audit history.
- Atomic locks and leases.
- Basic board and task detail.
- Backend authorization and role guardrails.

**Exit criterion:** the board and backend agree on task state, and concurrent claims cannot double-assign a task.

### Phase 2 — PM planning

Build:

- Persistent PM conversation.
- Project context retrieval.
- Structured plan generation.
- Task and dependency proposals.
- Editable acceptance criteria.
- Human plan approval.
- Task creation through the shared API.

**Exit criterion:** a natural-language feature request becomes an approved, executable task plan.

### Phase 3 — Local execution

Build:

- Runner registration and pairing.
- Workspace and Git worktree management.
- Claude Code CLI adapter (and a Codex CLI adapter, per D18).
- Run lifecycle and structured outcomes.
- Live logs and run controls.
- Developer task implementation.
- GitHub branch and PR creation.

**Exit criterion:** a Ready task produces a real PR without manual agent startup.

### Phase 4 — Review and documentation

Build:

- Reviewer agent.
- Review rounds and requested changes.
- Rebase handling.
- Evidence packets.
- Repository wiki conventions and context retrieval.
- Documentation review requirements.
- Durable artifact storage.

**Exit criterion:** a reviewer can reject a change, the developer can fix it, and the reviewer can validate the revised implementation and evidence.

### Phase 5 — Automatic merge and recovery

Build:

- Merge orchestrator.
- CI status tracking.
- Required evidence gates.
- Human review flag.
- Retry and review caps.
- Runner disconnect handling.
- Restart reconciliation.
- Notifications and human queue.
- Pause and kill switch.

**Exit criterion:** the entire Ready-to-Merged workflow operates reliably without manual orchestration, while respecting every required gate.

## 14. Definition of done for the MVP

The MVP is ready for private beta when a user can:

- Connect a GitHub repository.
- Pair a local runner.
- Describe a feature to the PM.
- Receive and edit a structured implementation plan.
- Approve tasks before execution.
- Respect task dependencies automatically.
- Run coding agents in isolated worktrees.
- View live agent activity.
- Produce a PR with tests and relevant wiki updates.
- Generate an evidence packet tied to acceptance criteria.
- Request changes and complete multiple review rounds.
- Enforce review, CI, and evidence gates.
- Automatically merge eligible PRs.
- Require human approval for flagged tasks.
- Recover safely from interrupted runs and expired locks.
- Pause or stop all execution.
- Inspect the audit history and understand every merge decision.

## 15. Success metrics

Track the following from the first usable release:

- **Autonomous completion rate:** Percentage of eligible Ready tasks merged without human intervention.
- **Review efficiency:** Median review rounds per merged PR.
- **Reliability:** Zero double-claimed tasks and zero merges that bypass required gates.
- **Recovery:** Percentage of interrupted runs reconciled without losing work or requiring manual database repair.
- **Scheduling efficiency:** Percentage of gate checks that correctly finish without starting an agent.
- **Cost per completion:** Model and infrastructure cost per merged task where measurable.
- **Documentation consistency:** Percentage of relevant implementation PRs that include required documentation updates.

The primary qualitative success criterion is that users spend their time deciding what to build and reviewing results, rather than coordinating agent sessions.

## 16. Open decisions

Resolve these before or during implementation:

- Which operating system is supported first by the local runner?
- ~~Which authentication approach is supported for Claude Code execution in the runner environment?~~ **Resolved for the POC by D2:** the user's own locally authenticated CLI. Revisit before selling.
- Should a task's first review be performed automatically immediately after the PR opens, or only after required CI completes?
- Which checks are mandatory by default, and which are configurable per project? *(Partly addressed by D6; see R4.)*
- What is the initial evidence storage provider?
- Should the PM use the same model as coding agents or a cheaper model by default?
- How should the product enforce one active Corral installation per repository?
- Which operations require explicit confirmation when a runner executes untrusted repository code?
- What is the recovery policy when GitHub reports a merge outcome ambiguously?

The initial defaults should favor safety, low cost, and minimal configuration.

## 17. Final product definition

Corral is a conversational AI Product Manager backed by a deterministic engineering control plane and replaceable execution runners.

The human describes outcomes and approves plans. The PM creates clear tasks. The scheduler assigns work. Coding agents implement changes in isolated workspaces. Reviewers verify the result and its evidence. The orchestrator merges only when all required gates pass.

The repository wiki is the shared technical memory of the actual implementation. Coding agents maintain it alongside code changes, while the PM reads it to plan work grounded in reality.

The MVP's defining workflow is:

> Idea → PM plan → human approval → task → isolated coding agent → PR → independent review → evidence → automated merge → updated repository knowledge.

Everything in the MVP should contribute directly to making that loop safe, reliable, observable, and inexpensive.
