# Stable page instances across selections

Inbox, global Settings, Plan session and task pages set a constant `definePageMeta` key. Agent pages key on the agent name, so changing the run keeps the runs list while changing agent creates a new page. Project routes retain Nuxt's default keys.

Inbox keeps its tab, search, task visibility and list scroll across item selection. Task-to-task clicks preserve the task query so the flyout stays mounted. Reply text, composer attachments, retry destination and human checklist belong to the selected item; evidence responses from a previous selection are ignored. Live refreshes of the same item preserve the reply draft. A send finishing for an older selection cannot clear the new reply or advance the new selection.

TaskDetail clears its editing fields, confirmation, attachments and loaded data on task-ref changes, and ignores responses for previous tasks. PlanConversation clears its reply, attached task and composer attachments when the session changes; a one-tap answer finishing in the previous session cannot restore its draft into the new thread. Agent run selection clears the transcript and ignores an older request that finishes after the selection changes.

These keys are the interim fix ahead of Inbox, Settings and agent nested routes. Parent/child routing should preserve these state boundaries when it replaces the keys.
