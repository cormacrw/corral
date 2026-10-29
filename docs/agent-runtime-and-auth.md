# Agent runtime and auth

How Corral runs the AI agents, why it's set up this way, and the rules that keep it swappable. Implements D2, D3 and D18 from [decisions.md](decisions.md).

## The model

```
Corral (control plane + runner)  ──starts──▶  `claude` CLI (Claude Code)  ┐  installed where the runner runs,
                                 ──starts──▶  `codex` CLI (Codex)         ┘  each logged in by the user, with their own account
```

There are two `AgentRuntime` adapters in the runner, one per CLI. They differ only in how they start the CLI and read its output; everything else is shared.

| | Claude Code adapter | Codex adapter |
|---|---|---|
| CLI | `claude` | `codex` |
| Login, by the human, in the runner container | `docker exec -it <runner> claude` | `docker exec -it <runner> codex login --device-auth` |
| Where the login lives | `claude-config` volume (`~/.claude`) | `codex-config` volume (`~/.codex`) |
| Headless run | `claude -p ... --output-format stream-json` | `codex exec ... --json` |
| Resuming a session (PM, D9) | `--resume <sessionId>` | `codex exec resume <sessionId>` |
| Vendor | Anthropic | OpenAI |

- The user installs and logs in to each CLI **themselves**: on the laptop in development, or with `docker exec -it` in the runner container once deployed (D12). Each CLI's config lives on a volume that only that CLI reads.
- The one thing the runner writes into those config directories is its pinned skills (`apps/runner/skills`, e.g. `grill-me`). At startup it copies them into `$CLAUDE_CONFIG_DIR/skills` (default `~/.claude/skills`) and `$CODEX_HOME/skills` (default `~/.codex/skills`), rewriting a file only when it differs. It never reads or changes anything else there, and a directory it can't write only gets a warning.
- Corral's runner starts the CLI headless inside the task's worktree (or the Plan session's checkout for the PM).
- Corral has no "Sign in with Claude" or "Sign in with ChatGPT" step. It never handles Anthropic or OpenAI tokens or API keys, and never sets `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Which agent uses which runtime

- **Developers and reviewers have exactly one runtime each** (D15, D18). Atlas is always Claude Code; a Codex developer or reviewer is a separate agent with its own concurrency, pause state and usage limits. A task's retries stay with the same agent, so a session never crosses vendors.
- **The PM can run on either.** The runtime is picked per Plan session and locked once the session has messages, because an agent session ID only works with the vendor that made it.
- The runner reports which CLIs are installed and signed in. The UI only offers those.

## Background: Anthropic's terms

Anthropic's Agent SDK docs (<https://code.claude.com/docs/en/agent-sdk/overview>, checked 2026-10-26) say:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

Using the SDK to power products offered to others is governed by Anthropic's Commercial Terms.

## Background: OpenAI's terms

Not checked yet (D18). Codex CLI can sign in with a ChatGPT account or an API key; Corral uses only the user's own ChatGPT login, done by the user. Whether OpenAI's terms allow a product to script the Codex CLI with a ChatGPT login, for the user or for others, has to be checked before any hosted or paid launch.

## How the terms apply to Corral

| Situation | Anthropic (`claude`) | OpenAI (`codex`) |
|---|---|---|
| **POC: Cormac alone, his own CLI logins and subscriptions** | Fine. Headless `claude -p` with a subscription is a documented, supported Claude Code feature; Corral is just scripting it. | Fine for the POC: `codex exec` is the CLI's documented non-interactive mode, run under the user's own login. |
| **Corral sold or used by others, still bring-your-own-CLI** | Probably fine, since Corral doesn't *offer* a login, but the "or rate limits" wording is a gray area. **Confirm with Anthropic before a hosted or paid launch.** | **Open item.** Check OpenAI's terms on scripting the Codex CLI with a ChatGPT login before a hosted or paid launch. |
| **Corral offering a subscription login, or holding subscription credentials on its servers** | Not allowed without Anthropic's approval. Don't build this. | Don't build this either, whatever the terms say: it breaks rule 1. |

Branding (Anthropic's docs page above): the product UI must not call agents "Claude Code" or "Claude Code Agent", or use Claude Code-styled visuals. "Claude", "Claude Agent" or "Powered by Claude" are allowed. Check OpenAI's brand guidelines before naming Codex in a hosted product.

## Rules for the build (keep the door open)

These apply to **both** adapters, and to any later one. They keep the POC simple while making a later move (API keys, Bedrock/Vertex, another agent CLI, cloud containers) a matter of writing a new adapter.

1. **Credentials never enter Corral.** No model-provider credential is stored in Corral's database, config, logs, prompts or worktrees, and Corral never sets one in an agent's environment. Each CLI reads its own auth from the user's environment. The one exception is the Jev key, which the server holds as an environment variable to route tasks (D15).
2. **Auth lives inside the `AgentRuntime` adapter.** The task model, scheduler, job spec (`RunJob`) and control-plane API must never mention subscriptions, API keys, or Claude or OpenAI specifically. A job names a role, a task and a neutral `runtime`, never an auth method.
3. **Keep `AgentRuntime` separate from `RunnerProvider`** (PRD §8.4). The runtime is *what* agent runs; the provider is *where* it runs (local worktree now, container later).
4. **Model, CLI binary and flags come from configuration, not code.** Per agent (PRD §4.4: "Model and runtime configuration").
5. **Usage limits are reported generically.** Each adapter turns its provider's signals into a neutral outcome such as `rate_limited { resetsAt?: timestamp }`. The scheduler handles it per D3, whether it came from a subscription window or an API quota, and pauses only the agent that hit it.
6. **Cost data is optional.** Subscription runs may report tokens but no dollar cost; API-key runs may report both. Metrics fields must allow either to be missing (PRD §11: "where available").
7. **Parse structured output.** Use each CLI's JSON output (`claude`'s stream-JSON, `codex exec --json`) for run events and outcomes, not scraped terminal text, and map both to the same event shape.
8. **Same tools for every runtime.** Both CLIs get the same per-run MCP server, so the agent tools and their fencing don't depend on the vendor (architecture.md).
9. **Sessions don't cross vendors.** An agent session ID is stored with the runtime that made it. Never pass one adapter's session ID to the other.

## What changes later (not now)

When Corral is packaged for other users, revisit:

- Supporting user-supplied API keys and/or Bedrock/Vertex as runtime configurations.
- Getting written confirmation from Anthropic on bring-your-own-CLI with subscription auth, and checking OpenAI's terms for Codex with a ChatGPT login.
- Cost per merged task as a user-facing metric (API-key users pay per token; a dev, review and fix loop could cost several dollars per task).

Future work, out of scope for D18:

- Handing a task or PM session off to the other vendor when one hits a usage limit.
- Requiring a task's reviewer to use a different vendor from its developer.
