<script setup lang="ts">
import { taskNumber } from '~/utils/labels'
import { errorMessage } from '~/lib/errors'
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Comment } from '@corral/contracts'
import { commentOnTask, taskCommentsQuery } from '~/queries/tasks'
import { actorLabel } from '~/features/activity/utils/auditText'

// A parent's comments, on its page and its flyout (D31)
const props = defineProps<{ slug: string, taskId: string, taskRef: string }>()
const address = computed(() => ({ slug: props.slug, number: taskNumber(props.taskRef), ref: props.taskRef }))
const comments = useQuery(computed(() => taskCommentsQuery(address.value)))
const send = useMutation(commentOnTask)
const toast = useToast()
const draft = ref('')
const composerDraft = { text: draft }

async function submit(body: string): Promise<boolean> {
  const text = draft.value
  draft.value = ''
  try {
    await send.mutateAsync({ task: { ...address.value, id: props.taskId }, body })
    return true
  } catch (e) {
    draft.value = text
    toast.add({ title: 'Could not comment', description: errorMessage(e), color: 'error' })
    return false
  }
}
const shell = useShell()
const authorLabel = (actor: Comment['author']) => actorLabel(actor, role => shell.agents.find(a => a.role === role)?.name ?? 'Agent')
const list = computed((): Comment[] => comments.data.value ?? [])
</script>

<template>
  <div class="flex flex-col gap-3 p-4">
    <div
      v-for="comment in list"
      :key="comment.id"
      class="text-sm"
    >
      <p class="text-xs text-muted-foreground">
        {{ authorLabel(comment.author) }}
      </p>
      <MarkdownText :text="comment.body" />
    </div>
    <p
      v-if="list.length === 0"
      class="text-sm text-muted-foreground"
    >
      No comments yet.
    </p>
    <DraftComposer
      :key="props.taskRef"
      :draft="composerDraft"
      placeholder="Comment…"
      hint="Saved as a note on this task."
      :project="props.slug"
      :draft-key="`task:${props.taskRef}`"
      @submit="submit"
    />
  </div>
</template>
