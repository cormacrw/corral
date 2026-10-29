# Pinned agent skills

The runner writes every directory here into the Claude Code and Codex
user-skills directories at startup (`src/skills.ts`). Files directly in this
directory, like this note and `LICENSE`, are not installed.

| Skill | Upstream path |
|---|---|
| `grill-me` | [`skills/productivity/grill-me`](https://github.com/mattpocock/skills/tree/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/productivity/grill-me) |
| `grilling` | [`skills/productivity/grilling`](https://github.com/mattpocock/skills/tree/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills/productivity/grilling) |

- Source: https://github.com/mattpocock/skills
- Commit: `59db609eb1e18aaf59b63284d0e52255aff0c63c`
- Licence: MIT, Copyright (c) 2026 Matt Pocock. The full notice is in [LICENSE](LICENSE).

Upstream, `grill-me` only tells the agent to call the `grilling` skill, so both
are pinned. The files are unmodified copies: to update them, copy both skill
directories from a newer upstream commit and change the commit above.
