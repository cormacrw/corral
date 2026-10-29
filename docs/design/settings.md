# Settings

**Canvas frames:** `App shell · Settings`, `Settings (component)`
**Route:** `/settings/:section` (`profile`, `agents`, `runner`, `appearance`)
**Scope:** global. These settings apply to every project. Per-project settings are in [project-settings.md](project-settings.md).

**Status: stub.** The structure is set. Most controls don't save yet in the design.

## Layout

- **Section menu** (left, 200–240px): "Settings" as the title, then a vertical `UNavigationMenu` (Profile, Agents, Runner, Appearance), and the note "Settings here apply to every project. Each project has its own settings in the sidebar." The active item uses `bg-elevated` with `text-primary`.
- **Content** (up to 880px): one bordered card per section. Rows use the same two-column pattern as project settings. Below about 800px the menu stacks on top.

## Sections

### Profile

- **Your name** (`UInput`): "How agents address you, and the author on approvals." Saved on the server (`PATCH /api/me`) when the field changes, so it is the same in every browser.
- **Picture:** a preview, **Upload picture** (**Change picture** once set) and **Remove**. Shown on your comments, approvals and in the sidebar footer.

### Agents

- **Header:** "Agents" with "Shared by every project. Each runs through your local CLI login; Corral never sees your credentials." (D1–D2), and **Add agent**.
- **One row per agent:** the name, a role badge, "{runtime} · concurrency 1 · `.corral/agents/<role>.md`", the agent's picture with **Upload picture** / **Remove**, and its name, concurrency and paused controls.
- **Edit screen** (to design): name, role, runtime (`USelectMenu`, offering only the detected CLIs; Claude Code or Codex, D18), concurrency, instructions file, and the caps that apply per role.

### Profile pictures

Pictures are optional; without one, an avatar shows initials. The browser crops the image to a centred square and scales it to 256px (WebP, or PNG where WebP can't be encoded) before uploading, so files stay small. The server accepts PNG, JPEG, WebP or GIF up to 2 MB, checks that the bytes match the declared type, and keeps the file in the blob store. Picture URLs carry part of the file's hash, so a new picture gets a new URL and an old one can be cached forever. Every avatar for that person or agent (sidebar, board cards, Inbox, comments, task properties) updates live.

### Runner

- **Status row:** a status dot, "Online · {runner name}", "Runs agents for every project · last heartbeat a few seconds ago", and **Reconnect**.
- **Data directory:** where the runner keeps clones, worktrees and its spool. It's read-only here: it comes from the runner's configuration and is a Docker volume (D12), never a hard-coded `~/.corral`.
- **Logins:** whether `claude`, `codex` and `gh` are signed in inside the runner container, with the `docker exec -it` command to sign in. Corral shows the state only and never reads the credentials (D2).

### Appearance

- **Colour mode:** a segmented control (System / Light / Dark), which maps to `useColorMode()`.
- **Layout:** a segmented control (Auto / Desktop / Mobile), saved per device. See [mobile.md](mobile.md).
- **Primary colour and font:** "Coming soon". For now they're set in `app.config.ts` and `main.css`.

## Open questions

- Should agent instructions be edited in the app, or only as files in the repo's `.corral/`?
- Does adding a second developer agent need its own name, or is it "Atlas" with concurrency 2?
- Usage limits are handled under D3, so where should the current limit window be shown: here, in the runner card, or on the agent pages?
