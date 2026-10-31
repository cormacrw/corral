import { ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

// Composer text that outlives its component, so leaving the page, opening a
// task or a layout swap on rotation doesn't lose it. sessionStorage: a draft
// belongs to this browser tab. An empty key is just a ref.
const PREFIX = 'corral.draft.'

export function readDraft(key: string): string {
  if (!key) return ''
  try {
    return sessionStorage.getItem(PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(key: string, text: string) {
  if (!key) return
  try {
    if (text) sessionStorage.setItem(PREFIX + key, text)
    else sessionStorage.removeItem(PREFIX + key)
  } catch {
    // Storage full or off: the draft still lives in the component
  }
}

// Where switching items clears the draft (the Inbox, a task), one item keeps
// a draft at a time. Prefix matching also takes a draft's saved images.
export function clearDraftsExcept(prefix: string, key: string) {
  try {
    for (const stored of Object.keys(sessionStorage)) {
      if (stored.startsWith(PREFIX + prefix) && stored !== PREFIX + key && !stored.startsWith(`${PREFIX}${key}:`)) sessionStorage.removeItem(stored)
    }
  } catch {
    // As above
  }
}

export function useDraft(key: MaybeRefOrGetter<string>) {
  const text = ref(readDraft(toValue(key)))
  // Synchronous, so the text never lands under the wrong key
  watch(() => toValue(key), (next) => {
    text.value = readDraft(next)
  }, { flush: 'sync' })
  watch(text, value => writeDraft(toValue(key), value), { flush: 'sync' })
  return text
}
