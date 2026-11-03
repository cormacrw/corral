import { computed, reactive } from 'vue'
import { shell } from '~/queries/shell'

// What every page shows: the shell's long-lived queries (queries/shell.ts) by
// name, read-only and empty until the shell starts. Change this data with a
// mutation.
export function useShell() {
  return reactive({
    loaded: computed(() => shell()?.loaded.value ?? false),
    error: computed(() => shell()?.error.value ?? null),
    projects: computed(() => shell()?.projects.data.value ?? []),
    agents: computed(() => shell()?.agents.data.value ?? []),
    // The human's profile (their picture)
    profile: computed(() => shell()?.profile.data.value ?? null),
    runner: computed(() => shell()?.runner.data.value ?? null),
    status: computed(() => shell()?.status.data.value ?? { stopped: false, updating: false }),
    inboxCount: computed(() => shell()?.inboxCount.data.value ?? 0),
    planSessions: computed(() => shell()?.planSessions.data.value ?? [])
  })
}
