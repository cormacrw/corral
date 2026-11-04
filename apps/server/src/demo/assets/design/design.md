# Field Notes: notes list and editor

The two screens people spend most of their time in. Calm greens, big tap
targets, and every note readable at arm's length outdoors.

## Screens

- `notes-list`: all notes, newest first, pinned notes on top with a green edge.
  Search and tag chips sit above the list. A note that hasn't synced yet has a
  dashed border and says "waiting to sync".
- `note-editor`: one note, with its time, place and coordinates above the
  title. Photos sit in a row under the text; the toolbar stays above the
  keyboard.

## Decisions

- Pinned notes get a 4 px green edge rather than an icon, so they stand out in
  sunlight (v2, from review feedback on v1).
- No floating action button over the list: the + sits in the header, where it
  can't cover the last note.
