# Reviewing spike findings in the Inbox

Desktop and mobile render the latest findings as markdown, followed by the shared EvidenceList with criterion verdicts and evidence. The human-review action is **Accept findings** for spikes and **Approve and merge** for other tasks. Both use the existing approve API action; spikes finish in Merged without a PR. Spike approval toasts and server-derived Resolved entries say **You accepted the findings**. Request changes keeps the existing feedback flow.

Spike Inbox context hides PR links and check badges. The prototype includes COR-39 with findings, a reviewer verdict and investigation evidence; its review actions update task status, retain change-request feedback and populate Resolved in memory.
