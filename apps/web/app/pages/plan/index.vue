<script setup lang="ts">
import { pickPlanTagline } from '~/features/plan/utils/plan-taglines'

// Plan, new session (design/plan.md)
const route = useRoute()
useSeoMeta({ title: 'Plan · Corral' })
// One tagline per visit. Crossing the phone breakpoint swaps the layout and
// remounts this page, so the pick lives in state until the route is left. A
// plain string, so clearing it on the way out can't change the heading.
const nextTagline = useState<string | null>('plan.tagline', () => null)
const tagline = nextTagline.value ??= pickPlanTagline()
onBeforeRouteLeave(() => {
  nextTagline.value = null
})
const initialProjectId = typeof route.query.project === 'string' ? route.query.project : undefined
</script>

<template>
  <AppPanel>
    <PlanNewSession
      :tagline="tagline"
      :initial-project-id="initialProjectId"
    />
  </AppPanel>
</template>
