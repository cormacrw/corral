# Board task card

`apps/web/app/components/TaskCard.vue` is the one card for the desktop Board and
`BoardMobile`. `docs/design/board.md` has the layout. The things that aren't
obvious from it:

- The card is a `div`, not a button, so the blocked icon can be a button inside
  it. The title is the keyboard control, and a click anywhere on the card does
  what the title does. Anything clickable added to the card must stop the click
  from reaching the card.
- With `to`, the title is a link: a click on it navigates by itself, so the
  card only calls `navigateTo` for clicks elsewhere. Without `to`, the title is a
  button and the card emits `open`, whose click bubbles up from the title too.
- The focus ring is drawn on the card with a `has-[...]` variant keyed on
  `data-card-title`, so a later button in the footer doesn't ring the whole card.
- The green dot compares `task.lease.agentId` with the displayed agent
  (`cardAssignee` in `utils/board.ts`). A leased task can show no dot, such as an
  In progress card whose lease is held by someone other than `task.developer`.
- `task.statusReason` used to reach the human through the card's note. It's now
  the Reason row in `TaskProperties`, in the flyout and on the task page.
