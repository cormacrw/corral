<script setup lang="ts">
import type { Token, Tokens } from 'marked'
import { marked } from 'marked'
import type { VNode } from 'vue'

// Agents write markdown (PM replies, transcripts, comments, summaries).
// Rendered from marked's tokens into Vue nodes rather than v-html, so agent
// output can never inject markup.
const props = defineProps<{ text: string }>()

const SAFE_HREF = /^(https?:|mailto:|\/|#)/i

function blocks(tokens: Token[]): VNode[] {
  return tokens.flatMap((token): VNode[] => {
    switch (token.type) {
      case 'space':
        return []
      case 'hr':
        return [h('hr', { class: 'border-default' })]
      case 'heading': {
        const depth = (token as Tokens.Heading).depth
        return [h(depth <= 2 ? 'h3' : 'h4', { class: depth <= 2 ? 'text-base font-semibold text-highlighted' : 'font-semibold text-highlighted' }, inline(token.tokens ?? []))]
      }
      case 'paragraph':
        return [h('p', inline(token.tokens ?? []))]
      case 'text':
        return [h('p', token.tokens ? inline(token.tokens) : (token as Tokens.Text).text)]
      case 'code':
        return [h('pre', { class: 'overflow-x-auto rounded-md border border-muted bg-muted px-3 py-2 font-mono text-xs/5 whitespace-pre' }, h('code', (token as Tokens.Code).text))]
      case 'blockquote':
        return [h('blockquote', { class: 'flex flex-col gap-2 border-s-4 border-accented ps-3 text-muted' }, blocks(token.tokens ?? []))]
      case 'list': {
        const list = token as Tokens.List
        return [h(list.ordered ? 'ol' : 'ul', {
          class: ['flex flex-col gap-1 ps-5', list.ordered ? 'list-decimal' : 'list-disc'],
          start: list.ordered && typeof list.start === 'number' && list.start !== 1 ? list.start : undefined
        }, list.items.map(item => h('li', { class: 'ps-0.5' }, item.task ? [h('input', { type: 'checkbox', checked: item.checked, disabled: true, class: 'me-1.5 align-middle' }), ...listItem(item)] : listItem(item))))]
      }
      case 'table': {
        const table = token as Tokens.Table
        const cell = (c: Tokens.TableCell, header: boolean) => h(header ? 'th' : 'td', { class: ['border border-accented px-2 py-1 text-start', header && 'bg-accented/50 font-medium'] }, inline(c.tokens))
        return [h('div', { class: 'overflow-x-auto' }, h('table', { class: 'border-collapse text-xs' }, [
          h('thead', h('tr', table.header.map(c => cell(c, true)))),
          h('tbody', table.rows.map(row => h('tr', row.map(c => cell(c, false)))))
        ]))]
      }
      default:
        return token.raw.trim() ? [h('p', token.raw.trim())] : []
    }
  })
}

// Tight list items are bare inline text; loose ones are paragraphs
function listItem(item: Tokens.ListItem): VNode[] | (VNode | string)[] {
  const loose = item.tokens.some(t => t.type !== 'text')
  if (!loose) return item.tokens.flatMap(t => t.type === 'text' && t.tokens ? inline(t.tokens) : [(t as Tokens.Text).text])
  return [h('div', { class: 'flex flex-col gap-1' }, blocks(item.tokens))]
}

function inline(tokens: Token[]): (VNode | string)[] {
  return tokens.map((token): VNode | string => {
    switch (token.type) {
      case 'strong': return h('strong', { class: 'font-semibold text-highlighted' }, inline(token.tokens ?? []))
      case 'em': return h('em', inline(token.tokens ?? []))
      case 'del': return h('s', inline(token.tokens ?? []))
      case 'codespan': return h('code', { class: 'rounded border border-muted bg-muted px-1 py-px font-mono text-xs' }, unescapeHtml((token as Tokens.Codespan).text))
      case 'br': return h('br')
      case 'link': {
        const href = (token as Tokens.Link).href
        if (!SAFE_HREF.test(href)) return h('span', inline(token.tokens ?? []))
        return h('a', { href, target: href.startsWith('/') || href.startsWith('#') ? undefined : '_blank', rel: 'noopener', class: 'text-primary hover:underline' }, inline(token.tokens ?? []))
      }
      case 'text': return token.tokens ? h('span', inline(token.tokens)) : unescapeHtml((token as Tokens.Text).text)
      default: return unescapeHtml('text' in token && typeof token.text === 'string' ? token.text : token.raw)
    }
  })
}

function unescapeHtml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&amp;', '&')
}

const Rendered = () => h('div', { class: 'flex min-w-0 flex-col gap-2 wrap-break-word' }, blocks(marked.lexer(props.text)))
</script>

<template>
  <Rendered />
</template>
