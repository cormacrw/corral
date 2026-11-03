import { asyncChunk, loadEpicDetail } from '~/utils/chunks'
import DetailLoading from '~/features/tasks/components/DetailLoading.vue'

export default asyncChunk(loadEpicDetail, DetailLoading)
