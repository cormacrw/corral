# Inbox quick actions

On desktop the Option D panel (`InboxPanel`) has no chips and no default action. Approve, Retry and Send back are sent on one click; Request changes, Answer and Delete take over the composer until they're sent or cancelled (Delete stays two steps because it can't be undone). With nothing chosen the composer replies as a task comment, addressed from the Inbox item, so it works when the task failed to load. Retry's status picker sits beside its button.

On a phone, task Inbox quick actions always select the first action on item identity/type changes, including auto-advance: approve for human review, clarify for blocked/question, resolve (Retry) for failed. Clicking a selected chip preserves it. Mobile chips use roving tabindex and wrapping arrow-key selection via `app/utils/radio.ts`.

The page owns default selection; mobile questions hide the chips and keep the Clarify composer answer flow. Activity and Plan threads retain their existing reply flows. Live refreshes of the same item must preserve a user's chosen action.

Approval's optional note, on desktop whatever is in the composer when Approve is clicked, is sent as trimmed `text` in the shared desktop/mobile Inbox action. Nonblank notes become unpinned human comments inside the task, bug, spike or design approval transaction; blank notes add nothing. Design notes also reach the PM build session. Request changes keeps the existing single pinned feedback comment. Epic PR reviews use their separate action contract.

Desktop one-click approval and Retry go through `InboxPanelTray` and the shared `PromptComposer.send()`, so attached images are included in the text just as when pressing Send. A quick action waits for pending image uploads; repeated clicks during that wait send only once. Overview screenshot grids and files appear only on reviews; other kinds keep their New artifacts in the message and show action help in Overview.
