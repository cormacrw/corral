<script setup lang="ts">
// Pull requests (design/pull-requests.md): every open PR in the project and
// where it stands against the merge gates, read live from GitHub
const device = useDevice()
const { prs, rows, summary, error, refetch, refreshing, refresh } = usePullRequests()
</script>

<template>
  <AppPanel>
    <div :class="['flex min-h-0 min-w-0 flex-1 flex-col', device.isMobile.value && 'overflow-y-auto overscroll-contain']">
      <template v-if="device.isMobile.value">
        <MobilePageHeader>
          <template #actions>
            <AppButton
              icon="i-hugeicons-refresh"
              variant="ghost"
              color="neutral"
              aria-label="Refresh"
              class="tap-target"
              :loading="refreshing"
              @click="refresh"
            />
          </template>
        </MobilePageHeader>
        <p
          v-if="prs"
          class="px-4 text-sm text-muted-foreground"
        >
          {{ summary }} · live from GitHub
        </p>
      </template>
      <ProjectToolbar v-else>
        <h1 class="font-semibold text-foreground">
          Pull requests
        </h1>
        <span
          v-if="prs"
          class="text-sm text-muted-foreground"
        >{{ summary }} · live from GitHub</span>
        <AppButton
          label="Refresh"
          icon="i-hugeicons-refresh"
          variant="outline"
          color="neutral"
          size="sm"
          class="ms-auto"
          :loading="refreshing"
          @click="refresh"
        />
      </ProjectToolbar>

      <AppLoadError
        v-if="error && !prs"
        :title="error.message"
        :retry="refetch"
        class="m-4"
      />
      <div
        v-else-if="!prs"
        class="flex flex-col gap-3 p-4"
      >
        <UiSkeleton class="h-10 w-full" />
        <UiSkeleton class="h-10 w-full" />
        <UiSkeleton class="h-10 w-full" />
      </div>
      <p
        v-else-if="rows.length === 0"
        class="p-4 text-sm text-muted-foreground"
      >
        No open pull requests. They show here once a developer opens one.
      </p>
      <PullRequestCards
        v-else-if="device.isMobile.value"
        :rows="rows"
      />
      <PullRequestTable
        v-else
        :rows="rows"
      />
    </div>
  </AppPanel>
</template>
