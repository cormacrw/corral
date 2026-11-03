import { asyncChunk, loadTaskDescription } from '~/utils/chunks'
import DescriptionLoading from '~/features/tasks/components/DescriptionLoading.vue'

export default asyncChunk(loadTaskDescription, DescriptionLoading)
