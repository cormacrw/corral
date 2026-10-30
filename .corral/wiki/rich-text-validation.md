# Rich-text description boundaries

Task create and patch inputs validate the full description tree before writing.
`packages/core/src/rich-text.ts` exports `richTextIssue`, shared by the contracts
schema and stored-document readers. API failures use `invalid_input` with an
issue path such as `description.content[0].content[1]` (encoded as path segments).

This is structural validation, not a TipTap schema or extension allowlist:
node and mark types must be non-empty strings, content and marks must be arrays,
text must be a string, and attrs must be objects. Converter-used image src/alt,
code-block language and link href accept strings or null; heading levels are
integers 1–6 and ordered-list starts are safe integers. Unknown node types,
marks, attributes and other editor metadata are preserved.

Markdown, plain-text and legacy plain-Markdown readers validate stored documents
before traversing them. Invalid data throws an Error naming the operation and
bad description path. Null/missing descriptions retain their empty behavior.

Structural validity does not mean a task is Ready. The existing core Ready
check still requires textual description content; an image alone does not count.
