import { toast } from 'vue-sonner'
import type { Tone } from '~/lib/tone'

export interface ToastOptions {
  title: string
  description?: string
  color?: Tone
  duration?: number
  actions?: { label: string, icon?: string, onClick?: () => unknown }[]
}

const SHOW = { success: toast.success, error: toast.error, warning: toast.warning, info: toast.info } as const

// One call for every notification, so features never touch the toast library
export function useToast() {
  return {
    add({ title, description, color, duration, actions }: ToastOptions) {
      const action = actions?.[0]
      const options = {
        description,
        duration,
        ...(action && { action: { label: action.label, onClick: () => action.onClick?.() } })
      }
      const show = color && color in SHOW ? SHOW[color as keyof typeof SHOW] : toast
      return { id: show(title, options) }
    },
    remove: (id: string | number) => toast.dismiss(id)
  }
}
