<script setup lang="ts">
import { Stepper, StepperDescription, StepperIndicator, StepperItem, StepperSeparator, StepperTitle, StepperTrigger } from '~/components/ui/stepper'

interface StepItem { title: string, description?: string, value?: string | number, icon?: string, disabled?: boolean }

const props = defineProps<{ items: readonly StepItem[], linear?: boolean, class?: string }>()
const model = defineModel<string | number>()
const stepOf = (index: number) => index + 1
const current = computed(() => {
  const index = props.items.findIndex(item => (item.value ?? 0) === model.value)
  return index < 0 ? 1 : stepOf(index)
})
function select(step: number | undefined) {
  if (step === undefined) return
  model.value = props.items[step - 1]?.value ?? step - 1
}
</script>

<template>
  <Stepper
    :model-value="current"
    :linear="linear"
    :class="props.class"
    @update:model-value="select"
  >
    <StepperItem
      v-for="(item, index) in items"
      :key="index"
      :step="stepOf(index)"
      :disabled="item.disabled"
      class="relative flex flex-1 items-center gap-2"
    >
      <StepperTrigger>
        <StepperIndicator>
          <Icon
            v-if="item.icon"
            :name="item.icon"
          />
          <template v-else>
            {{ stepOf(index) }}
          </template>
        </StepperIndicator>
      </StepperTrigger>
      <div class="min-w-0">
        <StepperTitle>{{ item.title }}</StepperTitle>
        <StepperDescription
          v-if="item.description"
          class="hidden sm:block"
        >
          {{ item.description }}
        </StepperDescription>
      </div>
      <StepperSeparator
        v-if="index < items.length - 1"
        class="h-px flex-1 bg-border"
      />
    </StepperItem>
  </Stepper>
</template>
