# Design bundle archives (D20)

`unpackBundle` in `packages/core/src/bundle.ts` is the only reader of a design bundle, on submission (`bundleProblem`) and when serving the preview. It reads ustar, GNU and pax tar.

It throws `BundleError`, naming the entry and offset, for: a header with a bad checksum or numeric field, an archive cut short anywhere (including on a block boundary, so the two-block end marker is required), a bad pax record, an empty long name, an extended header with no entry after it, and anything but zeros after the end marker. `submit_design` passes that message to the agent; only a sound archive can get the "no index.html" error.

**Duplicate paths are rejected.** No entry wins: `tar -cf` on a folder never writes duplicates, and `./a` and `a` count as the same path. Skipped entries don't count.

**Skipped on purpose, not errors:** folders, symlinks, hard links, other non-file entries, and files whose name fails `bundlePath` or is empty. A hard-linked file only appears under the name tar stored in full.

The preview treats an unreadable stored bundle as missing (404). Stored bundles came from `tar -cf` of a folder, so the stricter reader doesn't affect them.
