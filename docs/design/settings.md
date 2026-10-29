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
- **One row per agent:** the name, a role badge (PM, Developer, Designer or Reviewer; D23), "{runtime} · concurrency 1 · `.corral/agents/<role>.md`", the agent's picture with **Upload picture** / **Remove**, and its name, concurrency, wake interval and paused controls. The wake interval, in minutes, is how often the scheduler may start waiting work for that agent; blank means every tick. Events such as plan approval or a pushed PR still start the task they're about right away. The PM's row says "one turn per session" instead and has no concurrency or wake interval control: PM turns are limited only to one per Plan session (D9, D13), and the API refuses a PM concurrency or wake interval.
- **Add agent** opens a dialog: name, role (Developer, Designer or Reviewer; D23), runtime (`USelectMenu`, offering only the CLIs the runner detected, labelled "Claude" and "Codex", never "Claude Code"; D18) and concurrency. The new agent appears in the list live. Each developer, designer and reviewer row also has a runtime menu, disabled while the agent has active runs.
- **Edit screen** (to design): instructions file, and the caps that apply per role.

### Profile pictures

Pictures are optional; without one, an avatar shows initials. The browser crops the image to a centred square and scales it to 256px (WebP, or PNG where WebP can't be encoded) before uploading, so files stay small. The server accepts PNG, JPEG, WebP or GIF up to 2 MB, checks that the bytes match the declared type, and keeps the file in the blob store. Picture URLs carry part of the file's hash, so a new picture gets a new URL and an old one can be cached forever. Every avatar for that person or agent (sidebar, board cards, Inbox, comments, task properties) updates live.

### Runner

- **Runner list** (`RunnerList.vue`, live from `runner.status`): one row per runner the server knows, offline ones included. Each row has a server icon, the runner's name and a state badge, **Online** (`success`), **Offline** (`error`) or **Needs update** (`warning`). Under it: "{in use} of {slots} slots in use · {runtimes} · {roles}" (an offline runner shows just "{slots} slots"), and "Last heartbeat {time ago}". The slot count changes as runs start and end.
- **Needs update:** a runner whose hello speaks another protocol than the server is turned away (closed with 4000) but stays in the list with **Needs update** and "Speaks protocol {n}; this server expects protocol {m}. Update the runner to reconnect." It's listed until it reconnects on the current protocol. (The **Update now** button comes with the updater.)
- **Reconnect** (mobile) reloads the live state and scans the logins again.
- **Data directory:** where the runner keeps clones, worktrees and its spool. It's read-only here: it comes from the runner's configuration and is a Docker volume (D12), never a hard-coded `~/.corral`.
- **Logins:** each CLI's version and whether `claude`, `codex` and `gh` are signed in inside the runner container, with the `docker exec -it` command to sign in (`codex login --device-auth` for Codex, shown next to it when signed out). Corral shows the state only and never reads the credentials (D2).

### Appearance

- **Colour mode:** a segmented control (System / Light / Dark), which maps to `useColorMode()`.
- **Dark background:** swatch buttons for slate (default), gray, zinc, neutral, stone, mauve, olive, mist and taupe. Remaps neutral tokens only in dark mode; light mode stays slate. Shared by desktop and mobile, saved per device in `localStorage` (`corral.device.darkNeutral`) and restored in the static head before paint.
- **Layout:** a segmented control (Auto / Desktop / Mobile), saved per device. See [mobile.md](mobile.md).
- **Primary colour and font:** "Coming soon". For now they're set in `app.config.ts` and `main.css`.

## Open questions

- Should agent instructions be edited in the app, or only as files in the repo's `.corral/`?
- Does adding a second developer agent need its own name, or is it "Atlas" with concurrency 2?
- Usage limits are handled under D3, so where should the current limit window be shown: here, in the runner card, or on the agent pages?
