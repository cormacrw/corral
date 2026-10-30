# Evidence shapes (COR-212)

D21 keeps all eight kinds. `Evidence` in `packages/contracts/src/api.ts` is a
union discriminated by `kind`: notes have text, null file fields and size zero;
all other kinds have a file name, content type, download URL and byte size.
The shared `evidenceInputSchema` validates the agent API write boundary.
Notes require non-blank text and reject file fields; files require non-blank
names and content types plus uploaded bytes. The server calculates the size
from those bytes; clients cannot supply it. Empty files (size zero) are valid.

Migration 0038 locks and checks existing rows before changing constraints.
It stops with the offending IDs if historical rows violate the invariant;
it never deletes files, rewrites notes or invents metadata. Inspect and resolve
those rows before retrying. Valid screenshots, video, notes and raw artifacts
retain their IDs and metadata, so existing listing and download links continue
working. The SQL check also rejects negative sizes and whitespace-only metadata,
using the same Unicode whitespace set as JavaScript trim (including NBSP and BOM).

`packages/db/src/migrations.test.ts` exercises upgrades and invalid writes on
PGlite and Postgres; `apps/server/src/orchestrator.test.ts` covers the API and
note-only submissions through review. File range requests remain covered by
`apps/server/src/evidence-file.test.ts`.
