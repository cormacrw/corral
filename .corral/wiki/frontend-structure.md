# Frontend structure

`apps/web/app` is layered. A layer may use the ones above it in this list, never the ones below.

1. `components/ui`: stock shadcn-vue. Don't edit it; lint skips it. Add or update with `pnpm dlx shadcn-vue@latest add <name>` in `apps/web`, and delete what nothing uses, so the bundle and `pnpm audit` stay small.
2. `lib/tone.ts` and `components/app`: the `App*` composites. Tone, icon, loading and link handling live here once. Tailwind only finds literal class names, which is why `tone.ts` spells every pair out.
3. `components/shared`: product components that several features use, such as `PromptComposer` and `StatusBadge`.
4. `queries`: the only code that talks to the server (lint enforces it).
5. `features/<name>/{components,composables,utils}`: a product area. Components and composables are auto-imported by bare name, so names stay unique across features. Utils are imported explicitly.
6. `pages` and `layouts`: route handling and shells only.

Why `App*` instead of shadcn directly: tests mount components with stubs by name, and a button here needs an icon, a tone and a spinner almost everywhere. Writing that out at about 200 call sites is the markup Nuxt UI used to hide.

Coloured text uses `text-brand`, not `text-primary`: the preset's dark primary is a fill colour and is unreadable as text on dark surfaces.

The dark picker works by indirection. `.dark` in `theme.css` reads surfaces from a `--surface-*` ramp, and each `[data-dark-neutral]` rule in `dark-neutrals.css` repoints the ramp at a Tailwind palette.
