import { asyncChunk, loadEpicGraph } from '~/utils/chunks'
import GraphLoading from './GraphLoading.vue'

export default asyncChunk(loadEpicGraph, GraphLoading)
