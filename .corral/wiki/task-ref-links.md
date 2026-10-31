# Task refs in rendered output

`MarkdownText` links task references by default in prose, inline code and fenced
code, using every project's prefix from the shell query. Existing markdown links
retain their targets. `TaskRefText` uses the same matcher for plain transcript
thinking, tool output, raw input and system lines. Task descriptions use
`RichTextText` to preserve their JSON document structure and literal text while
linking refs. Acceptance criteria show linked markdown until selected for editing. None of these renderers uses `v-html`.

All generated links use `TaskLink`, with a real `/tasks/<ref>` href. Plain clicks
open the current page's mounted `TaskFlyout` on desktop. Without a host they go
to the task page. Mobile clicks use the thread's detail sheets when
`FLYOUT_SHEETS` is provided, otherwise the task page. `PlanConversation` provides
that capability for its own sheets, as does the Inbox mobile Plan thread.
Modified clicks and middle clicks retain native browser navigation. Missing
refs reach the existing TaskDetail error state.

Component checks cover cross-project refs, unknown prefixes, code styling,
explicit link targets, literal rich text, desktop host/mobile sheet navigation
and browser handling of modified clicks.
