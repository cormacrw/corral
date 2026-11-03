import { asyncChunk, loadEpicGraph } from '~/utils/chunks'
import GraphLoading from '~/features/epics/components/GraphLoading.vue'

export default asyncChunk(loadEpicGraph, GraphLoading)
