<script setup lang="ts">
import { reloadShell } from '~/queries/shell'
import { cliLoginCommand } from '~/utils/labels'
import { useCopy } from '~/composables/useCopy'

// Settings · Runner on mobile (design/settings.md, design/mobile.md): every
// runner's live status, the data directory and the logins inside it
const { clis, scan } = useCliScan()

// The browser can't restart the runner; this fetches its status again and
// scans the logins, like the live stream does after a reconnect
const reconnecting = ref(false)
async function reconnect() {
  reconnecting.value = true
  try {
    await reloadShell()
    await scan()
  } finally {
    reconnecting.value = false
  }
}

const GH_LOGIN = 'docker exec -it corral-runner gh auth login'
// The commands for the CLIs that need signing in, or the claude one to sign in again
const commands = computed(() => {
  const signedOut = (clis.value ?? []).filter(cli => cli.version && !cli.signedIn).map(cli => cliLoginCommand(cli.id))
  return signedOut.length ? signedOut : [cliLoginCommand('claude')]
})
const copy = useCopy()
</script>

<template>
  <div class="flex flex-col gap-6 p-4 pb-8">
    <section
      class="flex flex-col gap-4 rounded-lg border border-border p-4"
      data-testid="runner-card"
    >
      <RunnerList />
      <AppButton
        label="Reconnect"
        icon="i-ri-refresh-line"
        color="neutral"
        variant="outline"
        size="lg"
        block
        :loading="reconnecting"
        @click="reconnect"
      />
    </section>

    <section>
      <h2 class="mb-2 text-sm font-semibold text-foreground">
        Data directory
      </h2>
      <div class="rounded-lg border border-border bg-muted/50 p-3">
        <p class="font-mono text-sm">
          CORRAL_RUNNER_DATA_DIR
        </p>
        <p class="mt-1 text-xs text-muted-foreground">
          Clones, worktrees and the spool live here. It comes from the runner's configuration, on the runner-data volume when deployed.
        </p>
      </div>
    </section>

    <RunnerLogins
      title="Logins inside the runner"
      list-class="divide-y divide-border rounded-lg border border-border"
      skeleton-class="h-28 w-full"
    >
      <template #default="{ cli }">
        <li
          class="flex items-center gap-3 px-4 py-3"
          :data-testid="`cli-${cli.id}`"
        >
          <Icon
            name="i-ri-terminal-box-line"
            class="size-5 shrink-0 text-muted-foreground"
          />
          <div class="min-w-0 flex-1">
            <p class="font-medium text-foreground">
              {{ cli.id }}
            </p>
            <p class="truncate text-xs text-muted-foreground">
              {{ cli.name }} {{ cli.version ?? '(not found)' }}
            </p>
          </div>
          <AppBadge
            :label="cli.signedIn ? 'Signed in' : 'Not signed in'"
            :color="cli.signedIn ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
          />
        </li>
      </template>
    </RunnerLogins>

    <section class="flex flex-col gap-2">
      <p class="text-xs text-muted-foreground">
        To sign in, run this on the server:
      </p>
      <div
        v-for="command in [...commands, GH_LOGIN]"
        :key="command"
        class="flex items-center gap-2 rounded-lg bg-muted/50 py-2 ps-3 pe-1"
      >
        <code class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain font-mono text-xs whitespace-nowrap">{{ command }}</code>
        <AppButton
          icon="i-ri-file-copy-line"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Copy command"
          class="tap-target shrink-0"
          @click="copy(command)"
        />
      </div>
      <AppAlert
        icon="i-ri-shield-line"
        color="info"
        variant="subtle"
        title="Corral shows whether you're signed in. It never reads, stores or sends your credentials."
        class="mt-2"
      />
    </section>
  </div>
</template>
