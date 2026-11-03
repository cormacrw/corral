<script setup lang="ts">
import { provide, useId } from 'vue'
import { FIELD_ID } from '~/lib/field'
import { Label } from '~/components/ui/label'

defineProps<{ label?: string, help?: string, error?: string | boolean, required?: boolean }>()
const id = useId()
// Controls take this as their id, so the label always points at them
provide(FIELD_ID, id)
</script>

<template>
  <div
    class="flex flex-col gap-1.5"
    :data-invalid="error ? true : undefined"
  >
    <Label
      v-if="label"
      :for="id"
    >
      {{ label }}<span
        v-if="required"
        class="text-destructive"
        aria-hidden="true"
      > *</span>
    </Label>
    <slot :id="id" />
    <p
      v-if="typeof error === 'string' && error"
      class="text-xs text-destructive"
    >
      {{ error }}
    </p>
    <p
      v-else-if="help"
      class="text-xs text-muted-foreground"
    >
      {{ help }}
    </p>
  </div>
</template>
