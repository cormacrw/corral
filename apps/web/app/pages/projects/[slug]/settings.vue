<script setup lang="ts">
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { PatchProjectInput, Project } from '@corral/contracts'
import { DEFAULT_LIMITS } from '@corral/core'
import { ApiError } from '~/composables/useApi'
import { patchProject, projectsQuery, removeProject, setProjectThumbnail } from '~/queries/projects'
import { EPIC_REVIEW_MODE, THUMBNAIL_COLORS } from '~/utils/labels'

// Project settings (design/project-settings.md): form fields save together; pause and images apply immediately.
// On mobile the sections stack under the mobile header, which holds Save (design/mobile.md).
const route = useRoute()
const device = useDevice()
const router = useRouter()
const { data: projects } = useQuery(projectsQuery())
const patch = useMutation(patchProject)
const thumbnail = useMutation(setProjectThumbnail)
const removal = useMutation(removeProject)
const toast = useToast()
const slug = computed(() => String(route.params.slug))
const project = computed(() => projects.value?.find(p => p.slug === slug.value) ?? null)
useSeoMeta({ title: () => `Settings · ${project.value?.name ?? ''} · Corral` })

const form = reactive<Required<Omit<PatchProjectInput, 'paused'>>>({
  name: '', prefix: '', thumbnailColor: null, defaultBranch: 'main', mergeMethod: 'squash', requiredChecks: [], humanReviewDefault: false, epicReviewModeDefault: 'epic', ...DEFAULT_LIMITS
})
function fill(p: Project) {
  Object.assign(form, { name: p.name, prefix: p.prefix, thumbnailColor: p.thumbnailColor, defaultBranch: p.defaultBranch, mergeMethod: p.mergeMethod, requiredChecks: [...p.requiredChecks], humanReviewDefault: p.humanReviewDefault, epicReviewModeDefault: p.epicReviewModeDefault, reviewRoundCap: p.reviewRoundCap, failedRunCap: p.failedRunCap })
}
watch(project, (p, previous) => {
  if (!p) return
  // Immediate image writes and live events must not discard unsaved fields.
  const edits = previous?.id === p.id
    ? Object.fromEntries(Object.entries(form).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof Project])))
    : {}
  fill(p)
  Object.assign(form, edits)
}, { immediate: true })

const prefixValid = computed(() => /^[A-Z]{2,5}$/.test(form.prefix))
const dirty = computed(() => project.value
  ? JSON.stringify(form) !== JSON.stringify({
    name: project.value.name, prefix: project.value.prefix, thumbnailColor: project.value.thumbnailColor, defaultBranch: project.value.defaultBranch, mergeMethod: project.value.mergeMethod,
    requiredChecks: project.value.requiredChecks, humanReviewDefault: project.value.humanReviewDefault, epicReviewModeDefault: project.value.epicReviewModeDefault, reviewRoundCap: project.value.reviewRoundCap, failedRunCap: project.value.failedRunCap
  })
  : false)
const epicReviewModes = Object.entries(EPIC_REVIEW_MODE).map(([value, mode]) => ({ value, label: mode.label, description: mode.description }))
const saving = ref(false)
const saved = ref(false)
const prefixError = ref('')

async function save() {
  if (!project.value) return
  saving.value = true
  prefixError.value = ''
  try {
    await patch.mutateAsync({ slug: slug.value, input: { ...form } })
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 1800)
  } catch (e) {
    if (e instanceof ApiError && e.body?.code === 'conflict' && e.body.constraint?.includes('prefix')) prefixError.value = 'Another project uses this prefix.'
    else toast.add({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    saving.value = false
  }
}
async function setPaused(paused: boolean) {
  if (!project.value) return
  try {
    await patch.mutateAsync({ slug: slug.value, input: { paused } })
  } catch (e) {
    toast.add({ title: 'Could not change pause', description: e instanceof Error ? e.message : String(e), color: 'error' })
  }
}
const thumbnailInput = ref<HTMLInputElement | null>(null)
const thumbnailBusy = ref(false)
async function changeThumbnail(image: File | null) {
  const p = project.value
  if (!p || thumbnailBusy.value) return
  thumbnailBusy.value = true
  try {
    await thumbnail.mutateAsync({ slug: p.slug, image })
  } catch (e) {
    toast.add({ title: image ? 'Image not uploaded' : 'Image not removed', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    thumbnailBusy.value = false
  }
}
function uploadThumbnail(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const error = !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
    ? 'Choose a PNG, JPEG, WebP or GIF image.'
    : file.size > 2 * 1024 * 1024 ? 'The image is over 2 MB.' : null
  if (error) {
    toast.add({ title: 'Image not uploaded', description: error, color: 'error' })
    return
  }
  void changeThumbnail(file)
}
const checkChoices = ['lint', 'typecheck', 'test', 'build']
const toggleCheck = (name: string) => {
  form.requiredChecks = form.requiredChecks.includes(name) ? form.requiredChecks.filter(c => c !== name) : [...form.requiredChecks, name]
}
const customCheck = ref('')

// Remove: the server wants the exact name echoed back, so the confirm button waits for it
const removeOpen = ref(false)
const removeConfirm = ref('')
const removing = useRemovingProject()
function openRemove() {
  removeConfirm.value = ''
  removeOpen.value = true
}
async function remove() {
  const p = project.value
  if (!p || removeConfirm.value !== p.name) return
  removing.value = p.slug
  try {
    await removal.mutateAsync({ id: p.id, slug: p.slug, confirm: removeConfirm.value })
    removeOpen.value = false
    toast.add({ title: `Removed ${p.name}`, color: 'success' })
    const next = projects.value?.find(x => x.id !== p.id)
    await router.push(next ? `/projects/${next.slug}` : '/setup')
  } catch (e) {
    toast.add({ title: 'Not removed', description: e instanceof Error ? e.message : String(e), color: 'error' })
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <UDashboardPanel>
    <MobilePageHeader v-if="device.isMobile.value">
      <template #actions>
        <span
          v-if="saved"
          class="text-xs text-success"
        >Saved</span>
        <UButton
          label="Save"
          :disabled="!dirty || !prefixValid || !form.name.trim()"
          :loading="saving"
          @click="save"
        />
      </template>
    </MobilePageHeader>
    <div
      v-if="project"
      :class="['mx-auto flex w-full max-w-[880px] flex-col gap-6', device.isMobile.value ? 'p-4' : 'p-6']"
    >
      <template v-if="device.isMobile.value">
        <p class="text-sm text-muted">
          Settings for {{ project.name }} only. Agents and the runner are shared by every project and live in Settings.
        </p>
      </template>
      <header
        v-else
        class="sticky top-0 z-10 flex items-center gap-3 border-b border-default bg-default py-3"
      >
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-semibold">
            Project settings
          </h1>
          <p class="text-sm text-muted">
            Settings for {{ project.name }} only. Agents and the runner are shared by every project and live in Settings.
          </p>
        </div>
        <span
          v-if="saved"
          class="text-xs text-success"
        >Saved</span>
        <UButton
          label="Save changes"
          :disabled="!dirty || !prefixValid || !form.name.trim()"
          :loading="saving"
          @click="save"
        />
      </header>

      <UCard>
        <template #header>
          <h2 class="font-medium">
            General
          </h2>
        </template>
        <div class="flex flex-col gap-5">
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <label
                for="name"
                class="font-medium"
              >Name</label>
              <p class="text-xs text-muted">
                Required
              </p>
            </div>
            <UInput
              id="name"
              v-model="form.name"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Thumbnail</span>
              <p class="text-xs text-muted">
                Shown in the sidebar and overview
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="relative inline-flex"
                :aria-busy="thumbnailBusy"
              >
                <ProjectThumbnail
                  :project="{ ...project, name: form.name || project.name, thumbnailColor: form.thumbnailColor }"
                  :size="40"
                />
                <span
                  v-if="thumbnailBusy"
                  role="status"
                  aria-label="Updating thumbnail"
                  class="absolute inset-0 flex items-center justify-center rounded-lg bg-default/80"
                >
                  <UIcon
                    name="i-lucide-loader-circle"
                    class="size-5 animate-spin"
                  />
                </span>
              </span>
              <div
                role="radiogroup"
                aria-label="Thumbnail colour"
                class="flex gap-1.5"
              >
                <button
                  v-for="color in THUMBNAIL_COLORS"
                  :key="color"
                  type="button"
                  role="radio"
                  :aria-checked="form.thumbnailColor === color"
                  :aria-label="color"
                  :class="['size-6 rounded-full', form.thumbnailColor === color && 'ring-2 ring-primary ring-offset-2 ring-offset-default']"
                  :style="{ background: color }"
                  @click="form.thumbnailColor = color"
                />
              </div>
              <input
                ref="thumbnailInput"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label="Choose a project thumbnail"
                class="hidden"
                @change="uploadThumbnail"
              >
              <UButton
                label="Upload image"
                size="xs"
                variant="outline"
                color="neutral"
                :disabled="thumbnailBusy"
                @click="thumbnailInput?.click()"
              />
              <UButton
                v-if="project.thumbnailUrl"
                label="Remove image"
                size="xs"
                variant="ghost"
                color="neutral"
                :disabled="thumbnailBusy"
                @click="changeThumbnail(null)"
              />
            </div>
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <label
                for="prefix"
                class="font-medium"
              >Task ID prefix</label>
              <p class="text-xs text-muted">
                Next task: {{ form.prefix || project.prefix }}-{{ project.nextTaskNumber }}. Existing tasks keep their numbers.
              </p>
            </div>
            <UFormField :error="prefixError || (!prefixValid ? 'Use 2–5 letters, A–Z.' : undefined)">
              <UInput
                id="prefix"
                :model-value="form.prefix"
                :class="['font-mono', device.isMobile.value && 'w-full']"
                maxlength="5"
                @update:model-value="form.prefix = String($event).toUpperCase().replace(/[^A-Z]/g, '')"
              />
            </UFormField>
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-medium">
            Repository
          </h2>
        </template>
        <div class="flex flex-col gap-5">
          <div class="flex items-center gap-2 rounded-md bg-muted p-3 text-sm">
            <UIcon
              name="i-lucide-git-branch"
              class="size-4 text-muted"
            />
            <span class="font-mono">github.com/{{ project.repository }}</span>
            <span class="ms-auto text-xs text-muted">Cloned on the runner</span>
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <label
                for="branch"
                class="font-medium"
              >Default branch</label>
              <p class="text-xs text-muted">
                Agents branch from here and merge back into it.
              </p>
            </div>
            <UInput
              id="branch"
              v-model="form.defaultBranch"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <label
                for="epic-review-mode"
                class="font-medium"
              >Epic review mode</label>
              <p class="text-xs text-muted">
                For new epics a plan doesn't set a mode for. {{ EPIC_REVIEW_MODE[form.epicReviewModeDefault].description }}.
              </p>
            </div>
            <USelectMenu
              id="epic-review-mode"
              v-model="form.epicReviewModeDefault"
              :items="epicReviewModes"
              value-key="value"
              :search-input="false"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <span class="font-medium">Merge method</span>
            <USelectMenu
              v-model="form.mergeMethod"
              :items="[{ label: 'Squash and merge', value: 'squash' }, { label: 'Merge commit', value: 'merge' }, { label: 'Rebase and merge', value: 'rebase' }]"
              value-key="value"
              :search-input="false"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Required checks</span>
              <p class="text-xs text-muted">
                GitHub check names that must pass. With no checks, unflagged tasks merge on the reviewer's approval alone.
              </p>
            </div>
            <div class="flex flex-wrap gap-1.5">
              <UButton
                v-for="name in [...new Set([...checkChoices, ...form.requiredChecks])]"
                :key="name"
                :label="name"
                size="xs"
                :variant="form.requiredChecks.includes(name) ? 'subtle' : 'outline'"
                :color="form.requiredChecks.includes(name) ? 'primary' : 'neutral'"
                :aria-pressed="form.requiredChecks.includes(name)"
                @click="toggleCheck(name)"
              />
              <form
                class="flex gap-1"
                @submit.prevent="customCheck.trim() && (toggleCheck(customCheck.trim()), customCheck = '')"
              >
                <UInput
                  v-model="customCheck"
                  placeholder="Other check name"
                  size="xs"
                />
              </form>
            </div>
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h2 class="font-medium">
            Automation
          </h2>
        </template>
        <div class="flex flex-col gap-5">
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Pause project</span>
              <p class="text-xs text-muted">
                No new runs start; work already running finishes. Applies immediately.
              </p>
            </div>
            <USwitch
              :model-value="project.paused"
              aria-label="Pause project"
              @update:model-value="setPaused"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Human review for new tasks</span>
              <p class="text-xs text-muted">
                The default for each task's flag (D5)
              </p>
            </div>
            <USwitch
              v-model="form.humanReviewDefault"
              aria-label="Human review for new tasks"
            />
          </div>
          <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
            <div>
              <span class="font-medium">Limits</span>
              <p class="text-xs text-muted">
                Hitting a limit makes the task Blocked or Failed
              </p>
            </div>
            <div class="flex gap-3">
              <UFormField label="Review rounds">
                <UInputNumber
                  v-model="form.reviewRoundCap"
                  :min="1"
                />
              </UFormField>
              <UFormField label="Failed runs">
                <UInputNumber
                  v-model="form.failedRunCap"
                  :min="1"
                />
              </UFormField>
            </div>
          </div>
        </div>
      </UCard>

      <UCard :ui="{ root: 'ring-error/40' }">
        <template #header>
          <h2 class="font-medium text-error">
            Danger zone
          </h2>
        </template>
        <div class="grid gap-2 sm:grid-cols-[1fr_320px]">
          <div>
            <span class="font-medium">Remove project</span>
            <p class="text-xs text-muted">
              Stops every run and removes the project from Corral. Your repository, branches and PRs on GitHub are left alone.
            </p>
          </div>
          <UButton
            :label="`Remove ${project.name}`"
            color="error"
            variant="outline"
            @click="openRemove"
          />
        </div>
      </UCard>
      <UModal
        v-model:open="removeOpen"
        :title="`Remove ${project.name}?`"
        description="Stops every run and removes the project with its tasks, epics and plans from Corral. Your repository, branches and PRs on GitHub are left alone."
      >
        <template #body>
          <form
            id="remove-project"
            @submit.prevent="remove"
          >
            <UFormField :label="`Type ${project.name} to confirm`">
              <UInput
                v-model="removeConfirm"
                autocomplete="off"
                class="w-full"
              />
            </UFormField>
          </form>
        </template>
        <template #footer>
          <UButton
            label="Cancel"
            variant="outline"
            color="neutral"
            @click="removeOpen = false"
          />
          <UButton
            type="submit"
            form="remove-project"
            :label="`Remove ${project.name}`"
            color="error"
            :disabled="removeConfirm !== project.name"
            :loading="Boolean(removing)"
          />
        </template>
      </UModal>
    </div>
  </UDashboardPanel>
</template>
