<script setup lang="ts">
import type { CliStatus } from '@corral/contracts'
import { cliLoginCommand, timeAgo } from '~/utils/labels'

// Settings · Runner on mobile (design/settings.md, design/mobile.md): the
// runner's live status, its data directory and the logins inside it
const props = defineProps<{ clis: CliStatus[] | null, cliError: string | null }>()
const emit = defineEmits<{ scan: [] }>()
const live = useLive()
const runner = computed(() => live.state.value.runner)
const toast = useToast()

// The browser can't restart the runner; this fetches its status again and
// scans the logins, like the live stream does after a reconnect
const reconnecting = ref(false)
async function reconnect() {
  reconnecting.value = true
  try {
    await live.load()
    emit('scan')
  } finally {
    reconnecting.value = false
  }
}

const GH_LOGIN = 'docker exec -it corral-runner gh auth login'
// The commands for the CLIs that need signing in, or the claude one to sign in again
const commands = computed(() => {
  const signedOut = (props.clis ?? []).filter(cli => cli.version && !cli.signedIn).map(cli => cliLoginCommand(cli.id))
  return signedOut.length ? signedOut : [cliLoginCommand('claude')]
})
async function copy(command: string) {
  await navigator.clipboard?.writeText(command)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>

<template>
  <div class="flex flex-col gap-6 p-4 pb-8">
    <section
      class="flex flex-col gap-4 rounded-lg border border-default p-4"
      data-testid="runner-card"
    >
      <div class="flex items-start gap-3">
        <UIcon
          name="i-lucide-server"
          class="mt-0.5 size-6 shrink-0 text-muted"
        />
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 font-medium text-highlighted">
            <span
              :class="['size-2.5 shrink-0 rounded-full', runner?.online ? 'bg-success' : 'bg-error']"
              aria-hidden="true"
            />
            {{ runner?.online ? 'Online' : 'Offline' }} · {{ runner?.name ?? 'no runner yet' }}
          </p>
          <p class="text-xs text-muted">
            Runs agents for every project · last heartbeat {{ timeAgo(runner?.lastHeartbeatAt) }}
          </p>
        </div>
      </div>
      <UButton
        label="Reconnect"
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        size="lg"
        block
        :loading="reconnecting"
        @click="reconnect"
      />
    </section>

    <section>
      <h2 class="mb-2 text-sm font-semibold text-highlighted">
        Data directory
      </h2>
      <div class="rounded-lg border border-default bg-elevated/50 p-3">
        <p class="font-mono text-sm">
          CORRAL_RUNNER_DATA_DIR
        </p>
        <p class="mt-1 text-xs text-muted">
          Clones, worktrees and the spool live here. It comes from the runner's configuration, on the runner-data volume when deployed.
        </p>
      </div>
    </section>

    <section>
      <div class="mb-2 flex items-center">
        <h2 class="flex-1 text-sm font-semibold text-highlighted">
          Logins inside the runner
        </h2>
        <UButton
          label="Scan again"
          size="xs"
          variant="ghost"
          color="neutral"
          @click="emit('scan')"
        />
      </div>
      <UAlert
        v-if="cliError"
        color="warning"
        variant="subtle"
        :title="cliError"
      />
      <ul
        v-else-if="clis"
        class="divide-y divide-default rounded-lg border border-default"
      >
        <li
          v-for="cli in clis"
          :key="cli.id"
          class="flex items-center gap-3 px-4 py-3"
          :data-testid="`cli-${cli.id}`"
        >
          <UIcon
            name="i-lucide-terminal"
            class="size-5 shrink-0 text-muted"
          />
          <div class="min-w-0 flex-1">
            <p class="font-medium text-highlighted">
              {{ cli.id }}
            </p>
            <p class="truncate text-xs text-muted">
              {{ cli.name }} {{ cli.version ?? '(not found)' }}
            </p>
          </div>
          <UBadge
            :label="cli.signedIn ? 'Signed in' : 'Not signed in'"
            :color="cli.signedIn ? 'success' : 'warning'"
            variant="subtle"
            size="sm"
          />
        </li>
      </ul>
      <USkeleton
        v-else
        class="h-28 w-full"
      />
    </section>

    <section class="flex flex-col gap-2">
      <p class="text-xs text-muted">
        To sign in, run this on the server:
      </p>
      <div
        v-for="command in [...commands, GH_LOGIN]"
        :key="command"
        class="flex items-center gap-2 rounded-lg bg-elevated/50 py-2 ps-3 pe-1"
      >
        <code class="min-w-0 flex-1 overflow-x-auto overscroll-contain font-mono text-xs whitespace-nowrap">{{ command }}</code>
        <UButton
          icon="i-lucide-copy"
          variant="ghost"
          color="neutral"
          size="sm"
          aria-label="Copy command"
          @click="copy(command)"
        />
      </div>
      <UAlert
        icon="i-lucide-shield"
        color="info"
        variant="subtle"
        title="Corral shows whether you're signed in. It never reads, stores or sends your credentials."
        class="mt-2"
      />
    </section>
  </div>
</template>
