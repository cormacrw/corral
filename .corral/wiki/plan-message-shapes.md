# Plan message shapes

Plan messages are discriminated by role and kind (`planMessageFields` in `packages/contracts/src/plans.ts`): only a PM question carries `recommendation` or `options`. The server writes every message through `insertMessage` in `apps/server/src/plan.ts`.

The `plan_messages` CHECK constraints were added `NOT VALID`, so old rows were neither rewritten nor scanned. Keep that when changing them. Old rows are normalised when read by `toMessage`; an unknown PM kind shows as a plain message.

A new message kind has to be added in three places: `planMessageFields`, the `plan_messages_role_kind` check (a new migration), and `toMessage`, which otherwise shows it as a plain message.

`PlanThreadItem` is a union on `status`: `question` requires `question`, `needs_approval` requires `plan` and `planId`, and `none` requires `reply`. `sessionState` returns the question or plan row with its status, so the two can't disagree.
