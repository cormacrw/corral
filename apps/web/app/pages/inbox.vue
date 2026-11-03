<script setup lang="ts">
import { provideInboxView } from '~/features/inbox/composables/useInboxView'
import InboxLayout from '~/features/inbox/components/InboxLayout.vue'

// The Inbox, with the selected item in the child route
useSeoMeta({ title: 'Inbox · Corral' })
provideInboxView()
</script>

<template>
  <InboxLayout>
    <NuxtPage />
  </InboxLayout>
</template>
