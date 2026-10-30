<script setup lang="ts">
import { INBOX_PANEL_OPTIONS } from '~/composables/useInboxPanel'

// COR-190, prototype only: switches the Inbox message panel between today's
// and design options A–E. The choice is ?option= in the URL, so a link opens it.
const route = useRoute()
const router = useRouter()
const current = computed(() => typeof route.query.option === 'string' ? route.query.option : 'current')
const items = [{ label: 'Current', value: 'current' }, ...INBOX_PANEL_OPTIONS.map(o => ({ label: `Option ${o.label}`, value: o.value }))]
const name = computed(() => INBOX_PANEL_OPTIONS.find(o => o.value === current.value)?.name ?? 'Today\'s panel')
function pick(value: string | number) {
  const query = { ...route.query }
  if (value === 'current') delete query.option
  else query.option = String(value)
  void router.replace({ query })
}
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-dashed border-default bg-elevated/50 px-3 py-1.5"
    data-testid="inbox-option-switcher"
  >
    <UIcon
      name="i-lucide-flask-conical"
      class="size-4 shrink-0 text-muted"
    />
    <UTabs
      :model-value="current"
      :items="items.map(i => ({ ...i, label: i.label.replace('Option ', '') }))"
      :content="false"
      size="xs"
      class="shrink-0"
      @update:model-value="pick"
    />
    <span class="truncate text-xs text-muted">{{ name }}</span>
  </div>
</template>
