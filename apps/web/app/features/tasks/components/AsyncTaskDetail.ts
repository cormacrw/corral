import { asyncChunk, loadTaskDetail } from '~/utils/chunks'
import DetailLoading from '~/features/tasks/components/DetailLoading.vue'

export default asyncChunk(loadTaskDetail, DetailLoading)
