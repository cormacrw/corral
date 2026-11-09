<script setup lang="ts">
import { resolveComponent } from 'vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import type { Tone } from '~/lib/tone'

interface MenuItem {
  label: string
  icon?: string
  color?: Tone
  disabled?: boolean
  to?: string
  target?: string
  onSelect?: (event: Event) => unknown
}

const props = defineProps<{ items: readonly MenuItem[] | readonly (readonly MenuItem[])[], content?: { align?: 'start' | 'center' | 'end', side?: 'top' | 'right' | 'bottom' | 'left' } }>()
const groups = (): readonly (readonly MenuItem[])[] => (Array.isArray(props.items[0]) ? props.items : [props.items]) as readonly (readonly MenuItem[])[]
const NuxtLink = resolveComponent('NuxtLink')
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuContent
      :align="content?.align"
      :side="content?.side"
    >
      <template
        v-for="(group, index) in groups()"
        :key="index"
      >
        <DropdownMenuSeparator v-if="index > 0" />
        <DropdownMenuGroup>
          <DropdownMenuItem
            v-for="item in group"
            :key="item.label"
            :as-child="Boolean(item.to)"
            :disabled="item.disabled"
            :variant="item.color === 'error' ? 'destructive' : 'default'"
            @select="item.onSelect?.($event)"
          >
            <component
              :is="NuxtLink"
              v-if="item.to"
              :to="item.to"
              :target="item.target"
            >
              <Icon
                v-if="item.icon"
                :name="item.icon"
              />
              {{ item.label }}
            </component>
            <template v-else>
              <Icon
                v-if="item.icon"
                :name="item.icon"
              />
              {{ item.label }}
            </template>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
