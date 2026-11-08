import { asyncChunk } from '~/utils/chunks'
import { loadTaskDescription } from '~/features/tasks/utils/chunks'
import DescriptionLoading from '~/features/tasks/components/DescriptionLoading.vue'

export default asyncChunk(loadTaskDescription, DescriptionLoading)
