<script setup lang="ts">
import type { PullRequestDetail } from '@corral/contracts'
import { PULL_REQUEST_LINE_LIMIT } from '@corral/contracts/client'
import type { PullRequestGuideState } from '~/features/inbox/composables/usePullRequestGuide'
import { splitHunks } from '~/features/inbox/utils/guide'
import { plural, timeAgo } from '~/utils/labels'
import InboxGuideHunk from '~/features/inbox/components/InboxGuideHunk.vue'

// Guided code review (COR-518, design). The PR's hunks as an ordered story,
// each step with a title, why and its hunks. `outline` is the recommended
// layout: every step listed, one open at a time, Next marks it read. The
// `walkthrough` layout (option A) shows one step at a time with Previous and
// Next. A guide of a single step skips the list.
const props = withDefaults(defineProps<{ g: PullRequestGuideState, pr: PullRequestDetail, layout?: 'outline' | 'walkthrough', mobile?: boolean }>(), { layout: 'outline' })
const emit = defineEmits<{ openFile: [path: string] }>()
const github = computed(() => `${props.pr.url}/files`)
const hunkCount = computed(() => props.pr.files.reduce((n, f) => n + splitHunks(f.patch).length, 0))
const steps = computed(() => props.g.steps.value)
const single = computed(() => steps.value.length === 1)

// The open step: the first unread one, then wherever the reader goes
const openId = ref<string | null>(null)
watch(steps, (list) => {
  if (openId.value === null || !list.some(s => s.id === openId.value)) openId.value = (list.find(s => !props.g.isRead(s.id)) ?? list[0])?.id ?? null
}, { immediate: true })
const openIndex = computed(() => steps.value.findIndex(s => s.id === openId.value))
const root = ref<HTMLElement | null>(null)
const go = async (index: number) => {
  openId.value = steps.value[index]?.id ?? null
  await nextTick()
  root.value?.querySelector(`[data-step="${openId.value}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
const toggle = (id: string) => {
  openId.value = openId.value === id ? null : id
}
// Next marks the step read: reading it to the end is what read means
const next = (index: number) => {
  const step = steps.value[index]
  if (step) props.g.setRead(step.id, true)
  if (index + 1 < steps.value.length) void go(index + 1)
  else openId.value = props.layout === 'walkthrough' ? openId.value : null
}
const allRead = computed(() => steps.value.length > 0 && props.g.readCount.value === steps.value.length)
const truncatedTitle = computed(() => `Showing ${props.pr.files.length} of ${plural(props.pr.totalFiles, 'file')}, up to ${PULL_REQUEST_LINE_LIMIT.toLocaleString('en')} changed lines`)
</script>

<template>
  <div
    ref="root"
    class="flex flex-col gap-3"
    data-testid="inbox-guide"
  >
    <!-- Not generated: only made when asked for -->
    <div
      v-if="g.status.value === 'none'"
      class="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-4"
      data-testid="inbox-guide-none"
    >
      <div class="flex items-center gap-2">
        <Icon
          name="i-hugeicons-route-02"
          class="size-5 text-primary"
        />
        <h3 class="text-sm font-semibold text-foreground">
          Read this change as a story
        </h3>
      </div>
      <p class="text-sm text-muted-foreground">
        A small model orders this PR's {{ plural(hunkCount, 'hunk') }} into steps, each with why it matters for the task's criteria. It takes a few seconds and doesn't change the PR.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <AppButton
          label="Generate guide"
          icon="i-hugeicons-magic-wand-01"
          size="sm"
          data-testid="inbox-guide-generate"
          @click="g.generate"
        />
        <AppButton
          label="Read the files instead"
          variant="ghost"
          color="neutral"
          size="sm"
          @click="emit('openFile', '')"
        />
      </div>
    </div>

    <!-- Generating: the rest of the panel and Files stay usable -->
    <div
      v-else-if="g.status.value === 'generating' || g.status.value === 'loading'"
      class="flex flex-col gap-3"
      data-testid="inbox-guide-generating"
    >
      <div
        v-if="g.status.value === 'generating'"
        class="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Icon
          name="i-hugeicons-loading-03"
          class="size-4 animate-spin text-primary"
        />
        <span>Generating the guide from {{ plural(hunkCount, 'hunk') }}…</span>
        <AppButton
          label="Files"
          trailing-icon="i-hugeicons-arrow-right-02"
          variant="link"
          color="neutral"
          size="sm"
          class="ms-auto px-0"
          @click="emit('openFile', '')"
        />
      </div>
      <div
        v-for="n in 3"
        :key="n"
        class="flex items-center gap-3 rounded-lg border border-border p-3"
      >
        <UiSkeleton class="size-6 shrink-0 rounded-full" />
        <div class="flex flex-1 flex-col gap-1.5">
          <UiSkeleton :class="['h-4', n === 2 ? 'w-1/2' : 'w-3/4']" />
          <UiSkeleton class="h-3 w-full" />
        </div>
      </div>
    </div>

    <!-- Failed: say why, and try again -->
    <AppLoadError
      v-else-if="g.status.value === 'failed' || g.loadFailed.value"
      title="Couldn't generate the guide"
      :description="g.guide.value?.error ?? 'The guide didn\'t load.'"
      :retry="g.generate"
      data-testid="inbox-guide-error"
    />

    <template v-else-if="steps.length">
      <AppAlert
        v-if="pr.truncated"
        color="warning"
        variant="subtle"
        icon="i-hugeicons-scissor-01"
        :title="truncatedTitle"
        description="Steps that reach past the cap say so. The guide was made from the whole PR."
        :actions="[{ label: 'See the full diff on GitHub', to: github, target: '_blank', trailingIcon: 'i-hugeicons-arrow-up-right-01' }]"
        data-testid="inbox-guide-truncated"
      />

      <!-- One small change: no list, no Other changes -->
      <section
        v-if="single"
        class="flex flex-col gap-2"
        data-testid="inbox-guide-single"
      >
        <h3 class="text-sm font-semibold text-foreground">
          {{ steps[0]!.title }}
        </h3>
        <MarkdownText
          :text="steps[0]!.why"
          class="text-sm text-muted-foreground"
        />
        <InboxGuideHunk
          v-for="h in steps[0]!.hunks"
          :key="`${h.path}#${h.index}`"
          :hunk="h"
          :mobile="mobile"
          :github-url="github"
          @open-file="emit('openFile', $event)"
        />
        <AppCheckbox
          :model-value="g.isRead(steps[0]!.id)"
          label="I've read this change"
          @update:model-value="g.setRead(steps[0]!.id, !!$event)"
        />
      </section>

      <template v-else>
        <!-- Progress: how many steps are read, for this head commit -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span class="font-medium text-foreground">{{ plural(steps.length, 'step') }}</span>
          <span data-testid="inbox-guide-progress">{{ allRead ? 'All read' : `${g.readCount.value} of ${steps.length} read` }}</span>
          <span
            v-if="g.guide.value?.generatedAt"
            class="min-w-0 truncate"
          >Made {{ timeAgo(g.guide.value.generatedAt) }} for {{ g.guide.value.headSha?.slice(0, 7) }}</span>
        </div>
        <div
          class="flex gap-1"
          role="list"
          aria-label="Steps"
        >
          <button
            v-for="(s, i) in steps"
            :key="s.id"
            type="button"
            role="listitem"
            :aria-label="`Step ${i + 1}: ${s.title}${g.isRead(s.id) ? ', read' : ''}`"
            :aria-current="s.id === openId ? 'step' : undefined"
            :class="['h-1.5 flex-1 rounded-full transition-colors', g.isRead(s.id) ? 'bg-success' : s.id === openId ? 'bg-primary' : 'bg-muted hover:bg-muted-foreground/30']"
            @click="go(i)"
          />
        </div>

        <!-- Option A: one step at a time -->
        <section
          v-if="layout === 'walkthrough' && steps[openIndex]"
          class="flex flex-col gap-3"
          data-testid="inbox-guide-walkthrough"
        >
          <div class="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-background px-1 py-1">
            <AppButton
              icon="i-hugeicons-arrow-left-01"
              variant="outline"
              color="neutral"
              size="sm"
              aria-label="Previous step"
              :disabled="openIndex === 0"
              @click="go(openIndex - 1)"
            />
            <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {{ steps[openIndex]!.other ? 'Last' : `Step ${openIndex + 1} of ${steps.length}` }}
              <Icon
                v-if="g.isRead(steps[openIndex]!.id)"
                name="i-hugeicons-checkmark-circle-02"
                class="ms-1 size-4 align-text-bottom text-success"
              />
            </span>
            <AppButton
              :label="openIndex + 1 < steps.length ? 'Next' : 'Done'"
              :trailing-icon="openIndex + 1 < steps.length ? 'i-hugeicons-arrow-right-01' : 'i-hugeicons-checkmark-circle-02'"
              size="sm"
              @click="next(openIndex)"
            />
          </div>
          <h3 class="text-base font-semibold text-foreground">
            {{ steps[openIndex]!.title }}
          </h3>
          <MarkdownText
            :text="steps[openIndex]!.why"
            class="text-sm text-muted-foreground"
          />
          <InboxGuideHunk
            v-for="h in steps[openIndex]!.hunks"
            :key="`${h.path}#${h.index}`"
            :hunk="h"
            :mobile="mobile"
            :github-url="github"
            @open-file="emit('openFile', $event)"
          />
        </section>

        <!-- Recommended: the outline, one step open at a time -->
        <ol
          v-else
          class="flex flex-col gap-2"
          data-testid="inbox-guide-steps"
        >
          <li
            v-for="(s, i) in steps"
            :key="s.id"
            :data-step="s.id"
            :class="['scroll-mt-2 rounded-lg border', s.id === openId ? 'border-primary/40' : 'border-border', s.other && 'border-dashed']"
            data-testid="inbox-guide-step"
          >
            <div :class="['flex items-start gap-2 rounded-t-lg p-2', s.id === openId && 'sticky top-0 z-10 bg-background']">
              <!-- The mark: a number, a tick once read. Click it to mark or unmark. -->
              <button
                type="button"
                :class="['mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium', g.isRead(s.id) ? 'border-success bg-success text-success-foreground' : 'border-border text-muted-foreground hover:border-primary hover:text-primary']"
                :aria-pressed="g.isRead(s.id)"
                :aria-label="g.isRead(s.id) ? `Mark step ${i + 1} unread` : `Mark step ${i + 1} read`"
                :title="g.isRead(s.id) ? 'Read. Click to mark unread' : 'Mark read'"
                @click="g.setRead(s.id, !g.isRead(s.id))"
              >
                <Icon
                  v-if="g.isRead(s.id)"
                  name="i-hugeicons-tick-02"
                  class="size-3.5"
                />
                <Icon
                  v-else-if="s.other"
                  name="i-hugeicons-more-horizontal"
                  class="size-3.5"
                />
                <span v-else>{{ i + 1 }}</span>
              </button>
              <button
                type="button"
                class="flex min-w-0 flex-1 items-start gap-2 text-start"
                :aria-expanded="s.id === openId"
                @click="toggle(s.id)"
              >
                <span class="min-w-0 flex-1">
                  <span :class="['block text-sm font-medium', g.isRead(s.id) && s.id !== openId ? 'text-muted-foreground' : 'text-foreground']">{{ s.title }}</span>
                  <span
                    v-if="s.id !== openId"
                    class="block truncate text-xs text-muted-foreground"
                  >{{ plural(s.hunks.length, 'hunk') }} · {{ [...new Set(s.hunks.map(h => h.path.split('/').at(-1)))].join(', ') }}</span>
                </span>
                <Icon
                  :name="s.id === openId ? 'i-hugeicons-arrow-up-01' : 'i-hugeicons-arrow-down-01'"
                  class="mt-0.5 size-4 shrink-0 text-muted-foreground/70"
                />
              </button>
            </div>
            <div
              v-if="s.id === openId"
              class="flex flex-col gap-2 px-2 pb-2"
            >
              <MarkdownText
                :text="s.why"
                class="text-sm text-muted-foreground"
              />
              <div
                v-if="s.criteria.length"
                class="flex flex-wrap gap-1"
              >
                <AppBadge
                  v-for="c in s.criteria"
                  :key="c"
                  :label="c"
                  icon="i-hugeicons-target-02"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  class="h-auto max-w-full py-0.5 whitespace-normal"
                />
              </div>
              <InboxGuideHunk
                v-for="h in s.hunks"
                :key="`${h.path}#${h.index}`"
                :hunk="h"
                :mobile="mobile"
                :github-url="github"
                @open-file="emit('openFile', $event)"
              />
              <div class="flex items-center gap-2 pt-1">
                <AppButton
                  v-if="i > 0"
                  label="Previous"
                  icon="i-hugeicons-arrow-left-01"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  @click="go(i - 1)"
                />
                <AppButton
                  :label="i + 1 < steps.length ? 'Read · next step' : 'Read · done'"
                  :trailing-icon="i + 1 < steps.length ? 'i-hugeicons-arrow-down-01' : 'i-hugeicons-checkmark-circle-02'"
                  size="sm"
                  class="ms-auto"
                  data-testid="inbox-guide-next"
                  @click="next(i)"
                />
              </div>
            </div>
          </li>
        </ol>
      </template>
    </template>
  </div>
</template>
