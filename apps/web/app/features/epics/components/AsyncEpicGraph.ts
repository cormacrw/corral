import { asyncChunk } from '~/utils/chunks'
import GraphLoading from '~/features/epics/components/GraphLoading.vue'

// Vue Flow loads with it
export default asyncChunk(() => import('~/features/epics/components/EpicGraph.vue'), GraphLoading)
