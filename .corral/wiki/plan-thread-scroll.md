# Plan thread scrolling

`usePlanThreadScroll` owns the scroll policy for `PlanConversation`,
`InboxPlanThread` and `InboxMobilePlanThread`. Inbox still renders only the
current decision; Plan renders the conversation and live transcript.

Each view supplies a viewport ref, an inner content ref and a small state
signature. Opening or switching sessions goes to the bottom, including cached
sessions and sessions ending in a question. Post-render watchers handle the
initial refs and async data independently. Metadata-only snapshots do not
reposition the reader.

While open, updates follow when the reader is within 64px of the bottom;
scrolling up stops following. A human message resumes following. Only a newly
arriving question anchors to its top, with 16px of space; opening an existing
question does not. Inbox questions have no message ID in their contract, so
question timestamp and text identify a changed decision, and a local DOM marker identifies
its rendered question.

A ResizeObserver watches both the content and viewport, preserving the bottom
or question anchor as images, transcript steps, wrapping and layout changes
settle. Reader scrolls cancel the question anchor. Programmatic scroll events
are ignored by comparing the actual position with the last applied position.
The observer disconnects on unmount.
