# Frontend structure

`apps/web/app` is layered. A layer may use the ones above it in this list, never the ones below.

1. `components/ui`: stock shadcn-vue. Don't edit it; lint skips it. Add or update with `pnpm dlx shadcn-vue@latest add <name>` in `apps/web`, and delete what nothing uses, so the bundle and `pnpm audit` stay small. Two CLI quirks (shadcn-vue 2.9.0): it can't resolve the `utils` alias `cn` (the npm package) and fails with "resolvedPaths: Required", so set `utils` to `@/lib/utils` for the run, then rewrite `from '@/lib/utils'` back to `from 'cn'` and restore the alias. And its Hugeicons output imports icons from `@hugeicons/vue`; move them to `@hugeicons/core-free-icons` and render each as `<HugeiconsIcon :icon="…" :stroke-width="2" />`. It also adds a Google Fonts import to `main.css`; remove it (D32 bundles Geist).
2. `lib/tone.ts` and `components/app`: the `App*` composites. Tone, icon, loading and link handling live here once. Tailwind only finds literal class names, which is why `tone.ts` spells every pair out.
3. `utils`: plain helpers no single feature owns, such as `routes.ts` (every page's path, built once), `labels.ts`, `inbox-kinds.ts` and `install.ts`. Helpers the server shares, such as `errorText`, `clip` and `shortSha`, come from `@corral/core`.
4. `queries`: the only code that talks to the server (lint enforces it). `useShell()` (`queries/shell.ts`, auto-imported) is how every later layer reads the shell's long-lived queries.
5. `components/shared` and `composables`: product components and composables that several features use, such as `PromptComposer`, `StatusBadge`, `useTaskFlyout` and `useDarkNeutral`. Top-level composables are auto-imported like feature ones.
6. `features/<name>/{components,composables,utils}`: a product area. Components and composables are auto-imported by bare name, so names stay unique across features. Utils are imported explicitly.
7. `pages` and `layouts`: route handling and shells only.

Why `App*` instead of shadcn directly: tests mount components with stubs by name, and a button here needs an icon, a tone and a spinner almost everywhere. Writing that out at about 200 call sites is the markup Nuxt UI used to hide.

Coloured text uses `text-brand`, not `text-primary`: the preset's dark primary is a fill colour and is unreadable as text on dark surfaces.

The dark picker works by indirection. `.dark` in `theme.css` reads surfaces from a `--surface-*` ramp, and each `[data-dark-neutral]` rule in `dark-neutrals.css` repoints the ramp at a Tailwind palette.
