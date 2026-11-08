<script setup lang="ts">
import { projectColor } from '~/utils/labels'
import { mobileTitle, projectPage as projectSubPage, projectPath, SECTIONS, settingsPath, settingsSection as sectionOf } from '~/utils/routes'
import { usePlanStarts } from '~/queries/plan'

defineProps<{ compact?: boolean }>()
const route = useRoute()
const shell = useShell()
const pending = usePlanStarts()
const parts = computed(() => route.path.split('/').filter(Boolean))

// A project's own pages (Board, Backlog, Pull requests, Settings) name the project above
// the page and go back to its overview
const projectPage = computed(() => {
  const [section, slug, page] = parts.value
  const sub = projectSubPage(page)
  if (section !== 'projects' || !slug || !sub) return null
  const project = shell.projects.find(p => p.slug === slug)
  return { title: sub.label, eyebrow: project?.name ?? slug, back: projectPath(slug), backLabel: 'Back to the project', dot: project ? projectColor(project) : null }
})
// A Plan conversation names its project and session, goes back to a new
// session, and takes the full height: no runner status or tab bar
const planSession = computed(() => {
  const [section, id] = parts.value
  if (section !== 'plan' || !id) return null
  const session = shell.planSessions.find(s => s.id === id) ?? pending.entries.value[id]?.session
  const project = shell.projects.find(p => p.id === session?.projectId)
  return { title: session?.title ?? 'Plan', eyebrow: project?.name ?? 'Global', back: SECTIONS.plan.to, backLabel: 'Back to Plan', dot: project ? projectColor(project) : null }
})
// An Inbox item is its own screen: the task above where it sits in the
// list, a back button to the list, and the action bar at the bottom in place of
// the tab bar
const mobileHeader = useMobileHeader()
const inboxItem = computed(() => {
  const [section, id] = parts.value
  if (section !== 'inbox' || !id) return null
  return { title: mobileHeader.value?.title || 'Inbox', eyebrow: mobileHeader.value?.eyebrow ?? 'Inbox', back: SECTIONS.inbox.to, backLabel: 'Back to Inbox', dot: null }
})
const subPage = computed(() => projectPage.value ?? planSession.value ?? inboxItem.value)
// Agent and project overview screens have their own settings action
const agentPage = computed(() => parts.value[0] === 'agents' && parts.value.length === 2)
// Settings lists its sections at /settings, and each section is its own
// screen that goes back to the list.
const settingsSection = computed(() => parts.value[0] === 'settings' ? sectionOf(parts.value[1]) ?? null : null)
const overviewPage = computed(() => parts.value[0] === 'projects' && parts.value.length === 2)
const back = computed(() => subPage.value
  ? { to: subPage.value.back, label: subPage.value.backLabel }
  : agentPage.value
    ? { to: SECTIONS.home.to, label: 'Back to Home' }
    : overviewPage.value
      ? { to: SECTIONS.projects.to, label: 'Back to Projects' }
      : settingsSection.value
        ? { to: SECTIONS.settings.to, label: 'Back to Settings' }
        : null)
const action = computed(() => agentPage.value
  ? { to: settingsPath('agents'), icon: 'i-hugeicons-sliders-horizontal', label: 'Agent settings' }
  : overviewPage.value
    ? { to: projectPath(parts.value[1]!, 'settings'), icon: 'i-hugeicons-sliders-horizontal', label: 'Project settings' }
    : null)

const title = computed(() => subPage.value?.title ?? mobileTitle(route.path, shell.agents))
</script>

<template>
  <div
    data-testid="mobile-page-header"
    :class="['shrink-0 bg-background pt-(--shell-top) ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)]', compact && 'border-b border-border']"
  >
    <div :class="['flex items-center gap-2 px-4', compact ? 'min-h-14 py-2' : 'py-5']">
      <AppButton
        v-if="back"
        :to="back.to"
        icon="i-hugeicons-arrow-left-02"
        variant="ghost"
        color="neutral"
        :aria-label="back.label"
        class="tap-target -ms-2"
      />
      <div class="min-w-0 flex-1">
        <p
          v-if="subPage?.eyebrow"
          class="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            v-if="subPage.dot"
            class="size-2 shrink-0 rounded-full"
            :style="{ background: subPage.dot }"
            aria-hidden="true"
          />
          <span class="truncate">{{ subPage.eyebrow }}</span>
        </p>
        <h1 :class="['truncate font-semibold text-foreground', compact ? 'text-lg leading-tight' : 'text-2xl']">
          {{ title }}
        </h1>
      </div>
      <div
        class="flex shrink-0 items-center gap-1"
        data-testid="mobile-page-actions"
      >
        <slot name="actions" />
        <AppButton
          v-if="action"
          :to="action.to"
          :icon="action.icon"
          variant="ghost"
          color="neutral"
          :aria-label="action.label"
          class="tap-target"
        />
      </div>
    </div>
  </div>
</template>
