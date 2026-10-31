<script setup lang="ts">
import { isTaskDone } from '@corral/core'

import type { Task } from '@corral/contracts'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import type { Edge, Node } from '@vue-flow/core'
import { Handle, MarkerType, Position, VueFlow, useVueFlow } from '@vue-flow/core'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { PRIORITY, STATUS } from '~/utils/labels'

// An epic's tasks as a dependency tree: a task sits one step after the last
// task it depends on. Left to right on a page, top to bottom in the narrow
// flyout. Read-only; clicking a task opens it, including one from another epic.
const props = withDefaults(defineProps<{ tasks: Task[], selected?: string | null, minimap?: boolean, direction?: 'right' | 'down' }>(), { selected: null, minimap: false, direction: 'right' })
const emit = defineEmits<{ open: [ref: string] }>()

const NODE_WIDTH = 180
const NODE_HEIGHT = 64
const COLUMN_GAP = 48
const ROW_GAP = 12
// Fitting a small tree would otherwise zoom it in until the nodes are huge
const FIT = { padding: 0.15, maxZoom: 0.85 }

interface NodeData {
  task: Task | null
  // A dependency outside this epic, shown by its ref only
  ref: string
}

// Columns by longest dependency path, then each column ordered by where its
// dependencies sit (one barycentre pass keeps most edges from crossing)
const layout = computed(() => {
  const byRef = new Map(props.tasks.map(t => [t.ref, t]))
  const outside = [...new Set(props.tasks.flatMap(t => t.dependsOn).filter(ref => !byRef.has(ref)))]
  const refs = [...outside, ...props.tasks.map(t => t.ref)]
  const deps = (ref: string) => byRef.get(ref)?.dependsOn ?? []

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (ref: string): number => {
    const known = depth.get(ref)
    if (known !== undefined) return known
    if (visiting.has(ref)) return 0 // a cycle; core rejects these, but don't hang on one
    visiting.add(ref)
    const d = deps(ref).reduce((max, dep) => Math.max(max, depthOf(dep) + 1), 0)
    visiting.delete(ref)
    depth.set(ref, d)
    return d
  }
  refs.forEach(depthOf)

  const columns: string[][] = []
  for (const ref of refs) (columns[depth.get(ref)!] ??= []).push(ref)
  const row = new Map<string, number>()
  columns.forEach((column, c) => {
    if (c > 0) {
      const centre = (ref: string) => {
        const ys = deps(ref).map(d => row.get(d)).filter((y): y is number => y !== undefined)
        return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY
      }
      column.sort((a, b) => centre(a) - centre(b))
    }
    column.forEach((ref, i) => row.set(ref, i))
  })
  const tallest = Math.max(...columns.map(c => c.length), 1)
  const down = props.direction === 'down'
  // Steps run along one axis and siblings along the other
  const step = down ? NODE_HEIGHT + COLUMN_GAP : NODE_WIDTH + COLUMN_GAP
  const across = down ? NODE_WIDTH + ROW_GAP : NODE_HEIGHT + ROW_GAP
  const position = (ref: string) => {
    const column = columns[depth.get(ref)!]!
    // Shorter steps are centred against the widest
    const offset = (tallest - column.length) * across / 2 + row.get(ref)! * across
    const along = depth.get(ref)! * step
    return down ? { x: offset, y: along } : { x: along, y: offset }
  }

  const nodes: Node<NodeData>[] = refs.map(ref => ({
    id: ref,
    type: 'task',
    position: position(ref),
    sourcePosition: down ? Position.Bottom : Position.Right,
    targetPosition: down ? Position.Top : Position.Left,
    data: { task: byRef.get(ref) ?? null, ref },
    draggable: false,
    connectable: false
  }))
  const edges: Edge[] = props.tasks.flatMap(task => task.dependsOn.map((dep) => {
    const dependency = byRef.get(dep)
    const done = dependency ? isTaskDone(dependency) : false
    return {
      id: `${dep}->${task.ref}`,
      source: dep,
      target: task.ref,
      type: 'smoothstep',
      animated: byRef.get(dep)?.lease !== null && byRef.get(dep)?.lease !== undefined,
      markerEnd: MarkerType.ArrowClosed,
      class: done ? 'edge-done' : 'edge-waiting'
    }
  }))
  return { nodes, edges }
})

// Each graph needs its own store: the page and the flyout can both show one
const flowId = `epic-graph-${useId()}`
const { fitView } = useVueFlow(flowId)
// Re-fit when the tree changes shape (a task added or removed)
watch(() => `${props.direction}|${props.tasks.map(t => `${t.ref}:${t.dependsOn.join(',')}`).join('|')}`, () => {
  void nextTick(() => fitView(FIT))
})

const DOT = { neutral: 'bg-neutral-400', info: 'bg-info', primary: 'bg-primary', warning: 'bg-warning', error: 'bg-error', success: 'bg-success', secondary: 'bg-secondary' } as const
</script>

<template>
  <div
    data-epic-graph
    class="size-full min-h-0"
  >
    <VueFlow
      :id="flowId"
      :nodes="layout.nodes"
      :edges="layout.edges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :edges-updatable="false"
      :min-zoom="0.2"
      :max-zoom="1.5"
      class="size-full"
      @pane-ready="fitView(FIT)"
      @node-click="({ node }) => node.data.task && emit('open', node.data.task.ref)"
    >
      <template #node-task="{ data, sourcePosition, targetPosition }">
        <Handle
          type="target"
          :position="targetPosition"
        />
        <Handle
          type="source"
          :position="sourcePosition"
        />
        <div
          v-if="data.task"
          :class="[
            'flex cursor-pointer flex-col gap-0.5 rounded-md border bg-default px-2 py-1.5 text-start text-[11px] shadow-xs',
            props.selected === data.task.ref ? 'border-primary ring-1 ring-primary' : 'border-default hover:border-accented',
            data.task.status === 'draft' && 'border-dashed',
            data.task.lease && 'border-primary/60'
          ]"
          :style="{ width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
          :title="data.task.title"
        >
          <span class="flex items-center gap-1.5">
            <span class="font-mono text-muted">{{ data.task.ref }}</span>
            <span
              :class="['size-2 shrink-0 rounded-full', DOT[STATUS[data.task.status as keyof typeof STATUS].color]]"
              aria-hidden="true"
            />
            <span class="truncate text-muted">{{ STATUS[data.task.status as keyof typeof STATUS].label }}</span>
            <span
              v-if="data.task.priority === 'urgent' || data.task.priority === 'high'"
              :class="['ms-auto', data.task.priority === 'urgent' ? 'text-error' : 'text-warning']"
            >{{ PRIORITY[data.task.priority as keyof typeof PRIORITY].label }}</span>
          </span>
          <span class="line-clamp-2 text-xs/4 font-medium text-highlighted">{{ data.task.title }}</span>
        </div>
        <div
          v-else
          class="relative flex items-center justify-center rounded-md border border-dashed border-accented px-2 py-1.5 text-[11px] text-muted"
          :style="{ width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
        >
          <!-- The link covers the node, which has no click of its own -->
          <span><TaskLink
            :task-ref="data.ref"
            class="font-mono after:absolute after:inset-0"
          /> · another epic</span>
        </div>
      </template>
      <Background
        :gap="20"
        pattern-color="var(--ui-border)"
      />
      <Controls
        :show-interactive="false"
        position="bottom-left"
      />
      <MiniMap
        v-if="props.minimap"
        :width="160"
        :height="100"
        pannable
        zoomable
        position="bottom-right"
      />
    </VueFlow>
  </div>
</template>

<style>
/* Vue Flow's defaults assume a light page; use the app's tokens instead */
[data-epic-graph] .vue-flow__node-task {
  padding: 0;
  border: 0;
  background: transparent;
}
[data-epic-graph] .vue-flow__handle {
  opacity: 0;
}
[data-epic-graph] .vue-flow__edge-path {
  stroke-width: 1.5;
}
[data-epic-graph] .edge-waiting .vue-flow__edge-path {
  stroke: var(--ui-border-accented);
}
[data-epic-graph] .edge-done .vue-flow__edge-path {
  stroke: var(--ui-success);
}
[data-epic-graph] .vue-flow__arrowhead polyline {
  stroke: var(--ui-border-accented);
  fill: var(--ui-border-accented);
}
[data-epic-graph] .vue-flow__controls {
  box-shadow: none;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  overflow: hidden;
}
[data-epic-graph] .vue-flow__controls-button {
  background: var(--ui-bg-elevated);
  border-bottom-color: var(--ui-border);
  fill: var(--ui-text-muted);
}
[data-epic-graph] .vue-flow__controls-button:hover {
  background: var(--ui-bg-accented);
}
[data-epic-graph] .vue-flow__minimap {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
}
[data-epic-graph] .vue-flow__minimap-mask {
  fill: color-mix(in oklab, var(--ui-bg) 60%, transparent);
}
[data-epic-graph] .vue-flow__minimap-node {
  fill: var(--ui-bg-accented);
}
</style>
