import { asyncChunk, loadTaskDetail } from '~/utils/chunks'
import DetailLoading from './DetailLoading.vue'

export default asyncChunk(loadTaskDetail, DetailLoading)
