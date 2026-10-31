<script setup lang="ts">
import { h, type VNodeChild } from 'vue'
import { useTaskRefText } from '~/composables/useTaskRefText'
import { shownImageSrc } from '~/utils/editor-image'

// Read-only task descriptions retain their rich-text structure. Render nodes
// directly, so literal markdown characters in the editor remain literal.
interface Node {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string, attrs?: Record<string, unknown> }[]
  content?: Node[]
}
const props = defineProps<{ doc: unknown }>()
const textNode = useTaskRefText()
const safeHref = (href: unknown): href is string => typeof href === 'string' && /^(https?:|mailto:|\/|#)/i.test(href)
const safeImageSrc = (src: unknown): src is string => typeof src === 'string' && /^(https?:|attachment:|data:image\/|\/)/i.test(src)
const headingSize: Record<number, string> = { 1: 'text-lg', 2: 'text-base', 3: 'text-sm' }

function render(node: Node): VNodeChild {
  if (node.type === 'text') {
    const linked = node.marks?.some(mark => mark.type === 'link' && safeHref(mark.attrs?.href))
    let content: VNodeChild = linked ? node.text ?? '' : textNode(node.text ?? '')
    for (const mark of node.marks ?? []) {
      const tag = { bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code' }[mark.type]
      if (tag) content = h(tag, tag === 'code' ? { class: 'rounded border border-muted bg-muted px-1 font-mono text-xs' } : {}, [content])
      else if (mark.type === 'link' && safeHref(mark.attrs?.href)) {
        const href = mark.attrs.href
        content = h('a', { href, class: 'text-primary hover:underline', target: href.startsWith('/') || href.startsWith('#') ? undefined : '_blank', rel: 'noopener' }, [content])
      }
    }
    return content
  }
  const children = (node.content ?? []).map(render)
  switch (node.type) {
    case 'doc': {
      const empty = !node.content?.some(child => child.type !== 'paragraph' || child.content?.length)
      return h('div', { class: 'flex min-w-0 flex-col gap-2 wrap-anywhere' }, empty ? [h('p', { class: 'text-dimmed' }, 'Add a description…')] : children)
    }
    case 'paragraph': return h('p', children.length ? children : [h('br')])
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 2))
      return h(`h${level}`, { class: ['font-semibold text-highlighted', headingSize[level]] }, children)
    }
    case 'hardBreak': return h('br')
    case 'bulletList': return h('ul', { class: 'list-disc ps-5' }, children)
    case 'orderedList': return h('ol', { class: 'list-decimal ps-5', start: Number(node.attrs?.start) || 1 }, children)
    case 'listItem': return h('li', children)
    case 'blockquote': return h('blockquote', { class: 'border-s-4 border-accented ps-3 text-muted' }, children)
    case 'codeBlock': return h('pre', { class: 'overflow-x-auto rounded-md border border-muted bg-muted px-3 py-2 font-mono text-xs whitespace-pre' }, h('code', children))
    case 'horizontalRule': return h('hr', { class: 'border-default' })
    case 'image': {
      const { src, alt, title } = node.attrs ?? {}
      if (!safeImageSrc(src)) return typeof alt === 'string' ? alt : ''
      return h('img', { src: shownImageSrc(src), alt, title, class: 'max-w-full self-start rounded-md' })
    }
    default: return h('span', children)
  }
}
const Rendered = () => props.doc ? render(props.doc as Node) : h('p', 'Add a description…')
</script>

<template>
  <Rendered />
</template>
