# Task refs in rendered output

`MarkdownText` links task references by default in prose, inline code and fenced
code, using every project's prefix from the shell query. Existing markdown links
retain their targets. `TaskRefText` uses the same matcher for plain transcript
thinking, tool output, raw input and system lines, and for the Inbox's agent
text that isn't markdown: `InboxMessage`'s message and `InboxPanel`'s TL;DR. Task descriptions use
`RichTextText` to preserve their JSON document structure and literal text while
linking refs; it preserves underline marks and shows external and attachment images at their
natural size, capped at the column width. It drops the blank last paragraph the
editor keeps for typing, and a missing or empty description shows the dimmed
placeholder. Acceptance criteria show linked markdown until selected for editing. None of these renderers uses `v-html`.

All generated links use `TaskLink`, with a real `/tasks/<ref>` href. Plain clicks
open the current page's mounted `TaskFlyout` on desktop. Without a host they go
to the task page. Mobile clicks use the thread's detail sheets when
`FLYOUT_SHEETS` is provided, otherwise the task page. `PlanConversation` provides
that capability for its own sheets, as does the Inbox mobile Plan thread. The new
Plan page hosts a flyout and a sheet too, so opening an attached task, or its
epic from that sheet, keeps the composer's draft. A page that provides
`FLYOUT_SHEETS` must show both `?task` and `?epic`: epic controls in a task sheet
swap one for the other, and `plan/index.test.ts` covers this.
Modified clicks and middle clicks retain native browser navigation. Missing
refs reach the existing TaskDetail error state. An Inbox item opens with the
flyout closed and a live refresh doesn't touch it, so a task opened from a
message link stays in place.

Ref labels outside rendered text use `TaskLink` as well: Home agent lines, the
Inbox message header, "Refining" chips, live run lines, the selected run header,
epic review rows, the other-epic graph node and the project activity feed. Links can't nest, so a row or
card that is one link stays one link and its ref stays a label. Home agent cards
and live run cards also open something else, so their own link is an empty
`absolute inset-0` sibling after the content, and the `TaskLink` sits above it with
`relative z-10`. Run list rows and Needs-you rows keep their ref as a label.
`DesignChangedBadge` stays plain: a tooltip isn't reachable by keyboard or touch,
and the design link sits beside it.

Component checks cover cross-project refs, unknown prefixes, code styling,
explicit link targets, literal rich text, desktop host/mobile sheet navigation
and browser handling of modified clicks.

TaskDetail's Depends on refs and TaskProperties' pinned design version also use
`TaskLink` in every layout. Dependencies keep their monospace label; design
links use the slot for `REF vN`. Both therefore navigate to the task page when
there is no flyout host and stay in a Plan sheet when that capability is provided.
`TaskDetailLinks.test.ts` mounts the actual dependency list without a host and
checks its href and navigation, plus design links in both property layouts.
