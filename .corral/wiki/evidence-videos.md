# Evidence videos

Agents record `.webm` with agent-browser, and Safari on macOS and iOS often
can't decode that. `#readEvidence` in `apps/runner/src/run-manager.ts` therefore
sends any video other than MP4 through `convertToMp4`
(`apps/runner/src/evidence-video.ts`). The stored evidence is then `video/mp4`
with the same base name and an `.mp4` extension. An attached `.mp4` is never
re-encoded, even if its codec is something Safari can't play.

The 25 MB limit is checked against the MP4, so a larger recording that shrinks
is accepted. When the original fits but no usable MP4 exists (ffmpeg missing,
conversion failed or timed out, MP4 over the limit), the original is attached
with a run note giving the reason. When the original doesn't fit either, the
tool call fails with that reason.

Conversion is limited to 45 seconds. Together with the upload's 120-second
timeout, this leaves 15 seconds for file handling within Codex's 180-second
MCP tool budget. A timed-out conversion follows the same original-file and
run-note fallback, rather than continuing past the agent's tool deadline and
inviting duplicate attachments on retry.

ffmpeg comes from Debian in `apps/runner/Dockerfile`, so an environment without
it, such as a local dev runner, takes the fallback path.

The viewer's Download link uses the `download` attribute. It only works
same-origin, which holds because the web app proxies `/api`.
