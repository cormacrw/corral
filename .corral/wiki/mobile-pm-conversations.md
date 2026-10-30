# Mobile PM conversations

`MobileAgent.vue` sends current and previous PM turns with a `planSessionId`
to `/plan/:sessionId?project=:projectId`. The run response exposes the stored
session ID through `apps/server/src/runs.ts` and the shared `Run` contract.
Plan loads messages and project context from that saved session; follow-ups use
the existing session message endpoint, including its normal live-turn behaviour.
Runs without a linked session and every other role still open run transcripts.

The navigation specification is in `docs/design/mobile.md` under Agents.
