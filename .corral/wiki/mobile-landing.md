# Mobile launch destination

The setup middleware resolves `useDevice()` before choosing a redirect. Its
synchronous initialization reads the saved layout override and both media
queries, including standalone PWA mode, on the first navigation.

With projects present, `/` and completed `/setup` go to `/home` on mobile and
the first project's overview on desktop. The manifest still starts at `/`.
No projects still leads to onboarding on either layout; `/setup?add=1` stays
open for adding a project. Deep links keep their destination.

Implementation: `apps/web/app/middleware/setup.global.ts` and
`apps/web/app/utils/onboarding.ts`. Both have unit coverage beside them.
