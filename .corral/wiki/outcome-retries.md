# Outcome retries

A developer, designer or reviewer session that ends without `report_outcome` is resumed once to report (PRD §8.6, `#coldStart` in `apps/runner/src/run-manager.ts`).

## Background commands

An agent that ends its turn with a background command running prints a `result`, but the CLI stays alive when stdin closes. After `OUTCOME_EXIT_GRACE_MS` the runner sends SIGTERM to the process group, which is the usual exit code 143, and the command dies with it. Runner notes tell agents to wait in the foreground, and the retry prompt tells them to rerun a command their outcome depends on.

## The empty result on resume

Resuming that session makes the CLI announce the orphaned command before it reads our prompt, as a `result` with `subtype: success`, `num_turns: 0` and empty text. It comes ahead of the prompt's replay. Taken for the end of the turn, it closed stdin and started the 20-second countdown as the real turn began, so the retry was killed mid-tool with `Exit code 137` in its transcript.

`spawnAgentSession` drops such a result from its turns while a sent prompt hasn't been replayed. The check needs both conditions: error results must still end a turn, since a refused prompt may never be replayed. Warm PM turns use the same queue.

## The transcript

Notes record the grace kill, the exit that started the retry, and how the retry ended: reported, or exited with its code. A stop, a usage limit or an outside signal has its own note.
