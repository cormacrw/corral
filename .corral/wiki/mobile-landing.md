# Launch destination

With projects present, `/` and completed `/setup` go to `/home` on every
layout; the page itself picks the phone's single-column dashboard or the web
Home (`design/home.md`). The redirect no longer depends on `useDevice()`. The
manifest still starts at `/`. No projects still leads to onboarding;
`/setup?add=1` stays open for adding a project. Deep links keep their
destination. Finishing the wizard or adding a project still opens that project.

Implementation: `apps/web/app/middleware/setup.global.ts` and
`apps/web/app/features/setup/utils/onboarding.ts`. Both have unit coverage beside them.
