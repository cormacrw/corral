// The one vocabulary for colour across composites. Tailwind only sees literal
// class names, so every tone/appearance pair is written out here.
export type Tone = 'primary' | 'neutral' | 'success' | 'warning' | 'info' | 'error'
export type Appearance = 'solid' | 'outline' | 'soft' | 'subtle'
export type ButtonAppearance = Appearance | 'ghost' | 'link'

export const TONE_CLASSES: Record<Tone, Record<Appearance, string>> = {
  primary: {
    solid: 'bg-primary text-primary-foreground',
    outline: 'border-brand/50 text-brand',
    soft: 'bg-brand/10 text-brand',
    subtle: 'border-brand/25 bg-brand/10 text-brand'
  },
  neutral: {
    solid: 'bg-foreground text-background',
    outline: 'border-border text-foreground',
    soft: 'bg-muted text-foreground',
    subtle: 'border-border bg-muted text-foreground'
  },
  success: {
    solid: 'bg-success text-background',
    outline: 'border-success/50 text-success',
    soft: 'bg-success/10 text-success',
    subtle: 'border-success/25 bg-success/10 text-success'
  },
  warning: {
    solid: 'bg-warning text-background',
    outline: 'border-warning/50 text-warning',
    soft: 'bg-warning/10 text-warning',
    subtle: 'border-warning/25 bg-warning/10 text-warning'
  },
  info: {
    solid: 'bg-info text-background',
    outline: 'border-info/50 text-info',
    soft: 'bg-info/10 text-info',
    subtle: 'border-info/25 bg-info/10 text-info'
  },
  error: {
    solid: 'bg-destructive text-background',
    outline: 'border-destructive/50 text-destructive',
    soft: 'bg-destructive/10 text-destructive',
    subtle: 'border-destructive/25 bg-destructive/10 text-destructive'
  }
}

const HOVER: Record<Tone, { fill: string, wash: string }> = {
  primary: { fill: 'hover:bg-primary/80', wash: 'hover:bg-brand/15' },
  neutral: { fill: 'hover:bg-foreground/80', wash: 'hover:bg-muted' },
  success: { fill: 'hover:bg-success/80', wash: 'hover:bg-success/15' },
  warning: { fill: 'hover:bg-warning/80', wash: 'hover:bg-warning/15' },
  info: { fill: 'hover:bg-info/80', wash: 'hover:bg-info/15' },
  error: { fill: 'hover:bg-destructive/80', wash: 'hover:bg-destructive/15' }
}

const TEXT: Record<Tone, string> = {
  primary: 'text-brand',
  neutral: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  info: 'text-info',
  error: 'text-destructive'
}

export function buttonToneClass(tone: Tone, appearance: ButtonAppearance): string {
  if (appearance === 'ghost') return `${TEXT[tone]} ${HOVER[tone].wash}`
  if (appearance === 'link') return `${TEXT[tone]} underline-offset-4 hover:underline`
  return `${TONE_CLASSES[tone][appearance]} ${appearance === 'solid' ? HOVER[tone].fill : HOVER[tone].wash}`
}

export const TONE_TEXT: Record<Tone, string> = {
  primary: 'text-brand', neutral: 'text-muted-foreground', info: 'text-info', warning: 'text-warning', success: 'text-success', error: 'text-destructive'
}
