// Copies to the clipboard and says how that went. navigator.clipboard is
// missing on plain HTTP, which a home server can be.
export function useCopy() {
  const toast = useToast()
  return async function copy(text: string, title = 'Copied') {
    try {
      if (!navigator.clipboard) throw new Error('This browser blocks the clipboard here.')
      await navigator.clipboard.writeText(text)
      toast.add({ title, color: 'success' })
    } catch (e) {
      toast.add({ title: 'Could not copy', description: e instanceof Error ? e.message : String(e), color: 'error' })
    }
  }
}
