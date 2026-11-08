import { h } from 'vue'
import TaskLink from '~/components/shared/TaskLink.vue'
import { useShell } from '~/queries/shell'

// Read all projects at render time so newly loaded prefixes take effect too.
export function useTaskRefText() {
  const shell = useShell()
  return (text: string) => {
    const prefixes = shell.projects.map(p => p.prefix)
    if (!prefixes.length) return text
    const escaped = prefixes.map(prefix => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`\\b((?:${escaped.join('|')})-\\d+)\\b`)
    return h('span', text.split(pattern).map((part, i) => i % 2
      ? h(TaskLink, { taskRef: part }, () => part)
      : part))
  }
}
