# Agent runtime and auth

How Corral runs the AI agent, why it's set up this way, and the rules that keep it swappable. Implements D2 and D3 from [decisions.md](decisions.md).

## The model

```
Corral (control plane + runner)  ──starts──▶  `claude` CLI installed where the runner runs
                                               (logged in by the user, with their own account)
```

- The user installs Claude Code and logs in **themselves**: on the laptop in development, or with `docker exec -it` in the runner container once deployed (D12). In the container, the CLI's config lives on a volume that only the CLI reads.
- Corral's runner starts the CLI headless (e.g. `claude -p ... --output-format json` / `stream-json`) inside the task's worktree.
- Corral has no "Sign in with Claude" step and never handles Anthropic tokens or API keys.

## Background: Anthropic's terms

Anthropic's Agent SDK docs (<https://code.claude.com/docs/en/agent-sdk/overview>, checked 2026-10-26) say:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

Using the SDK to power products offered to others is governed by Anthropic's Commercial Terms.

How that applies to Corral:

| Situation | Assessment |
|---|---|
| **POC: Cormac alone, his own CLI and subscription** | Fine. Headless `claude -p` with a subscription is a documented, supported Claude Code feature; Corral is just scripting it. |
| **Corral sold or used by others, still bring-your-own-CLI** | Probably fine, since Corral doesn't *offer* a login, but the "or rate limits" wording is a gray area. **Confirm with Anthropic before a hosted or paid launch.** |
| **Corral offering Claude subscription login, or holding subscription credentials on its servers** | Not allowed without Anthropic's approval. Don't build this. |

Branding (same docs page): the product UI must not call agents "Claude Code" or "Claude Code Agent", or use Claude Code-styled visuals. "Claude", "Claude Agent" or "Powered by Claude" are allowed.

## Rules for the build (keep the door open)

These keep the POC simple while making a later move (API keys, Bedrock/Vertex, a different agent CLI, cloud containers) a matter of writing a new adapter.

1. **Credentials never enter Corral.** No model-provider credential is stored in Corral's database, config, logs, prompts or worktrees. The CLI reads its own auth from the user's environment. The one exception is the Jev key, which the server holds as an environment variable to route tasks (D15).
2. **Auth lives inside the `AgentRuntime` adapter.** The task model, scheduler, job spec (`RunJob`) and control-plane API must never mention subscriptions, API keys, or Claude specifically. A job names a role and a task, never an auth method.
3. **Keep `AgentRuntime` separate from `RunnerProvider`** (PRD §8.4). The runtime is *what* agent runs; the provider is *where* it runs (local worktree now, container later).
4. **Model, CLI binary and flags come from configuration, not code.** Per agent group (PRD §4.4: "Model and runtime configuration").
5. **Usage limits are reported generically.** The adapter turns provider-specific signals into a neutral outcome such as `rate_limited { resetsAt?: timestamp }`. The scheduler handles it per D3, whether it came from a subscription window or an API quota.
6. **Cost data is optional.** Subscription runs may report tokens but no dollar cost; API-key runs may report both. Metrics fields must allow either to be missing (PRD §11: "where available").
7. **Parse structured output.** Use the CLI's JSON/stream-JSON output for run events and outcomes, not scraped terminal text, so another runtime can produce the same event shape.

## What changes later (not now)

When Corral is packaged for other users, revisit:

- Supporting user-supplied API keys and/or Bedrock/Vertex as runtime configurations.
- Getting written confirmation from Anthropic on bring-your-own-CLI with subscription auth.
- Cost per merged task as a user-facing metric (API-key users pay per token; a dev, review and fix loop could cost several dollars per task).
