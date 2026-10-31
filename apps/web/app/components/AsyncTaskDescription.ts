import { asyncChunk, loadTaskDescription } from '~/utils/chunks'
import DescriptionLoading from './DescriptionLoading.vue'

export default asyncChunk(loadTaskDescription, DescriptionLoading)
