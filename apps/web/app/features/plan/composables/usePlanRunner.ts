import { computed } from 'vue'

// The PM by its current name and picture, and the runner every turn of it needs
export function usePlanRunner() {
  const shell = useShell()
  const pm = computed(() => shell.agents.find(a => a.role === 'pm') ?? null)
  const offline = computed(() => shell.loaded && !shell.runner?.online)
  const unavailable = computed(() => `${pm.value?.name ?? 'The PM'} is unavailable while the runner is offline`)
  return { pm, offline, unavailable }
}
