# Inbox quick actions

The Option D panel (`InboxPanel`) has no chips and no default action, except that a phone opens a question with Answer chosen. Approve, Retry and Send back are sent on one click; Request changes, Answer and Delete take over the composer until they're sent or cancelled (Delete stays two steps because it can't be undone). With nothing chosen the composer replies as a task comment, addressed from the Inbox item, so it works when the task failed to load. Retry's status picker sits beside its button.

On a phone the actions are `InboxPanelThumbBar`'s 64px targets, plus Reply. Its `InboxPanelTray` stays mounted while closed, so a one-tap action goes through the same `PromptComposer.send()` as desktop and keeps picked images. The tray stays open while it holds a draft, because a one-tap action sends that draft as its note and shouldn't send what can't be seen. Epic items, Plan threads and release notes keep their own layouts.

The page owns default selection, reset on item identity/type changes, including auto-advance. Plan threads retain their existing reply flow. Live refreshes of the same item must preserve a user's chosen action.

Approval's optional note, whatever is in the composer when Approve is clicked, is sent as trimmed `text` in the shared desktop/mobile Inbox action. Nonblank notes become unpinned human comments inside the task, bug, spike or design approval transaction; blank notes add nothing. Design notes also reach the PM build session. Request changes keeps the existing single pinned feedback comment. Epic PR reviews use their separate action contract.

One-click approval and Retry go through `InboxPanelTray` and the shared `PromptComposer.send()`, so attached images are included in the text just as when pressing Send. A quick action waits for pending image uploads; repeated clicks during that wait send only once. Overview screenshot grids and files appear only on reviews; other kinds keep their New artifacts in the message and show action help in Overview.
