# Corral

Before planning or building anything, read [docs/README.md](docs/README.md). It indexes the PRD, the decisions that override it, and the precedence order between them.

Current phase: local-only POC, single user, agents run through the user's own locally authenticated `claude` CLI. Never handle model-provider credentials in Corral (see `docs/decisions.md` D1–D2).
