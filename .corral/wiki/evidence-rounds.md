# Evidence rounds

Evidence views show each criterion's latest submission and hide what it
replaced. `features/evidence/utils/evidenceRounds.ts` decides this for every
view: the Criteria tab and task Evidence tab (`EvidenceList`), the Inbox
Overview screenshots and files (`useInboxPanel` `files`) and the epic
Overview carousel (`InboxEpicOverview`).

- **A submission is a run, not a round.** Runs are ordered by their first
  evidence's `createdAt`. Changes requested advances the round before the
  developer attaches again, and a resubmission can reuse the round
  (`review-round-eligibility.md`), so two runs in one round are two
  submissions and only the later one's items are current.
- **Per group.** Each criterion, and the "Task as a whole" group, shows the
  items of the newest run that attached anything to it. If that isn't the
  task's latest run, they stay current with a "From round N" badge. The server
  only requires this round's evidence for criteria that aren't human-checked,
  so this mostly shows on human-checked criteria and same-round resubmissions.
- **Earlier rounds.** Older items sit in a closed "Earlier rounds (N)"
  disclosure per group (`EvidenceRounds.vue`), grouped by round, newest first,
  dimmed. A group with one run has no disclosure, so single-run tasks look as
  before.
- **Viewer.** `EvidenceList` passes the viewer the files as listed: current
  ones, plus a group's earlier ones only while its disclosure is open.

Demo: SHOP-8 (Expired promo codes, in Human review) has two developer rounds,
including a human-checked criterion carried from round 1.
