# Inbox quick actions

The Option D panel (`InboxPanel`) has no chips and no default action, except that a question opens on Answer on a phone. Approve, Retry and Send back are sent on one click; Request changes, Answer and Delete take over the composer until they're sent or cancelled (Delete stays two steps because it can't be undone). With nothing chosen the composer replies as a task comment, addressed from the Inbox item, so it works when the task failed to load. Retry's status picker sits beside its button.

On a phone the same actions sit in `InboxPanelThumbBar`, with Reply beside them. It keeps `InboxPanelTray` mounted behind `v-show`, because a one-tap action sends through the tray's composer: unmounting it on the tap would lose the draft and images. Reply is the bar's own state, not an action, since `action: null` is also the bar at rest.

The page owns default selection. Activity and Plan threads retain their existing reply flows. Live refreshes of the same item must preserve a user's chosen action.

Approval's optional note, on desktop whatever is in the composer when Approve is clicked, is sent as trimmed `text` in the shared desktop/mobile Inbox action. Nonblank notes become unpinned human comments inside the task, bug, spike or design approval transaction; blank notes add nothing. Design notes also reach the PM build session. Request changes keeps the existing single pinned feedback comment. Epic PR reviews use their separate action contract.

One-click approval and Retry go through `InboxPanelTray` and the shared `PromptComposer.send()`, so attached images are included in the text just as when pressing Send. A quick action waits for pending image uploads; repeated clicks during that wait send only once. Overview screenshot grids and files appear only on reviews; other kinds keep their New artifacts in the message and show action help in Overview.
