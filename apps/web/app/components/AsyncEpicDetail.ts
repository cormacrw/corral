import { asyncChunk, loadEpicDetail } from '~/utils/chunks'
import DetailLoading from './DetailLoading.vue'

export default asyncChunk(loadEpicDetail, DetailLoading)
