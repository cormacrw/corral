# Corral

Before planning or building anything, read [docs/README.md](docs/README.md). It indexes the PRD, the decisions that override it, and the precedence order between them.

Current phase: local-only POC, single user, agents run through the user's own locally authenticated `claude` CLI. Deployed as Docker containers on the user's home server, so nothing may assume macOS or hard-coded local paths (`docs/decisions.md` D12). Never handle model-provider credentials in Corral (see `docs/decisions.md` D1–D2).
