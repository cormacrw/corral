# Reviewing spike findings in the Inbox

Desktop and mobile render the latest findings as markdown, followed by the shared EvidenceList with criterion verdicts and evidence. The human-review action is **Accept findings** for spikes and **Approve and merge** for other tasks. Both use the existing approve API action; spikes finish in Merged without a PR. Spike approval toasts and server-derived Resolved entries say **You accepted the findings**. Request changes keeps the existing feedback flow.

Spike Inbox context hides PR links and check badges. The prototype includes COR-39 with findings, a reviewer verdict and investigation evidence; its review actions update task status, retain change-request feedback and populate Resolved in memory.

Reviewer approval retains spike worktrees through Human review, regardless of the human-review flag; only human acceptance schedules cleanup. Inbox task details are matched to the selected task ID, and submission waits for those details, so auto-advance cannot reuse the previous task’s labels, checks or criteria. If the details fail to load, the tray shows the error with Retry: approval stays blocked because its human-criteria check needs the task, while the other actions stay available. Desktop and mobile share the spike classification.
