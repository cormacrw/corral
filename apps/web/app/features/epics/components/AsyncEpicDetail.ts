import { asyncChunk } from '~/utils/chunks'
import DetailLoading from '~/components/shared/DetailLoading.vue'

export default asyncChunk(() => import('~/features/epics/components/EpicDetail.vue'), DetailLoading)
