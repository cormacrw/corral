import { asyncChunk } from '~/utils/chunks'
import { loadTaskDetail } from '~/features/tasks/utils/chunks'
import DetailLoading from '~/components/shared/DetailLoading.vue'

export default asyncChunk(loadTaskDetail, DetailLoading)
