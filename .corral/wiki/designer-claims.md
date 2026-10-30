# Designer task claims (COR-157)

Design authoring belongs only to designers (D23). Developers claim Ready or
unleased In progress tasks other than design; designers claim only design
in those statuses. Both use the same priority/status ordering, dependency and
epic-dependency gates, pause controls and capacity limits. Without an eligible
designer a design stays Ready. Reviewers still review every task type.

The orchestrator prepares designer jobs with designerPrompt and
designerRevisionPrompt, on the existing design/<ref> branch. Session affinity
and resume require the same agent and authoring role. Historical developer
runs therefore cannot supply a designer session, even if that agent has since
changed roles; existing branches, versions and feedback remain available.
The runner's existing `design` capacity flag controls placement of designer
jobs, while the job and stored run role are `designer`.

The task API's `developer` field names the latest designer for design tasks;
the UI's Developer property therefore shows the designer. Live designers take
human messages and task edit notices under the same runtime and lease rules as
developers. The runner also gives designers streaming input and preserves and
publishes their branch work. New design authoring runs go only to designers; normal developer prompts
contain no design authoring instructions. Already-live developer-authored
designs retain their existing submission tools so they can finish (D23). Build tasks pinned
to approved designs still receive read-only reference context.

Coverage: claim.test.ts exercises exclusive task types, paused designers and
both dependency gates in Ready/In progress. design.test.ts exercises fresh
sessions after historical developer runs and designer revisions producing v2.
run-messages.test.ts and runner run-manager-messages.test.ts cover delivery
through the server socket and into an agent process, respectively.
