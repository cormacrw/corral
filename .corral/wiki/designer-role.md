# Designer role and bootstrap (COR-156)

The shared agent role union and database enum include `designer` (D23).
Migration `0035_amused_bloodaxe.sql` only adds the enum value; it preserves
existing agents, roles and runs.

Server bootstrap fills missing roles by role, including Iris, a Claude
(`claude-code`) designer alongside Juno, Atlas and Vera. A customized designer
already satisfies bootstrap; restarting never adds another when one exists.
If a default name is already used by another role, bootstrap adds a numeric
suffix rather than leaving the missing role unseeded.

`POST /api/agents` accepts `designer` with the same runtime validation and
configuration as developers and reviewers. `GET /api/agents` orders designers
after developers and before reviewers. The PM remains a singleton created by
bootstrap.

Designer actor labels read “Designer” in server comment context and in web
activity/history role fallbacks. Existing run attribution still uses the
agent's configured name when available.

This change supplies the role, persistence and seed foundation. Design task
routing and server authoring are now covered by [designer claims](designer-claims.md)
(COR-157). Settings authoring controls remain separate D23 work. The runner role registries include designer outcomes,
authoring tools and a built-in instructions fallback so the new shared role is
represented exhaustively.

Verification: bootstrap tests cover existing/custom agents and repeated starts;
API tests cover designer create/list on PGlite and Postgres; migration tests
compare complete pre-existing agents and runs before and after the additive
migration on both engines.

## Web surfaces (COR-159)

Settings offers Designer between Developer and Reviewer, with the repository
instructions hint `.corral/agents/designer.md`. Agent pages share designer stat
tiles on desktop and mobile: authoring runs this week, submitted versions,
approved design tasks, average run and token usage today. Version and approval
totals cover the API's recent run window (up to 50 runs), attributed by the
version's immutable commit to this
agent's designer runs; an approved version's retained Plan session preserves
approval credit after supersession. Missing version data displays an error
rather than a fabricated zero.

The task API's existing `developer` property is the authoring slot: for design
tasks it names the latest designer run. Task properties label it Designer,
including the unassigned fallback and working avatar. Board cards show the
designer's avatar, and design revision feedback addresses the designer. The
static prototype includes Iris, an active design task (COR-20), a completed
submission and an approved version; Add agent updates its in-memory live list.

## Corral's own designer instructions (COR-160)

Corral's repository overrides the built-in designer defaults with
`.corral/agents/designer.md`, which replaces them entirely, so it repeats their
workflow. It holds the prototype build notes that used to be in `CLAUDE.md`, so
only designers get them; `CLAUDE.md` keeps a one-line pointer.

Verified end to end in a local `pnpm dev` stack using only a
`cormacrw/test-app` project, with Corral's sources and unchanged designer
instructions staged in its local checkout. Iris built the prototype with
`pnpm --filter web prototype`, wrote `design.md`, captured desktop and mobile
screenshots, committed on `design/TA-2`, and called `submit_design` successfully.
The server recorded v1 with ten screenshots; `report_outcome(design_submitted)`
succeeded and the sandboxed preview rendered in the task's Design panel.
The project was paused after claiming the designer run; no PR or merge was
created. Submission responses and the rendered version are attached to COR-160.

For this nested dev-stack check, Turbo's strict environment mode stripped the
existing runner-provided git author variables. Start `pnpm dev --env-mode=loose`
with the existing author environment, but without the outer developer shell's
`GIT_CONFIG_*` push guard: Corral's runner needs to push the test design branch,
while it adds its own push guard to the designer's shell. Do not configure a
new git identity or remove the guard from the designer itself.
