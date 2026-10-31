import { VueQueryPlugin } from '@tanstack/vue-query'
import { createQueryClient } from '~/queries/client'
import { connectPendingPlanCache } from '~/composables/usePendingPlan'
import { connectQueries } from '~/queries/live'

// The app is client-only (ssr: false), so there is no state to dehydrate
export default defineNuxtPlugin((nuxtApp) => {
  const queryClient = createQueryClient()
  nuxtApp.vueApp.use(VueQueryPlugin, { queryClient })
  connectPendingPlanCache(queryClient)
  connectQueries(queryClient)
})
