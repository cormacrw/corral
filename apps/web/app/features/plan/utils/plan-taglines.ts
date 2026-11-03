// The new Plan page's heading, one picked at random on each visit
export const planTaglines = [
  'What should we plan?',
  'What are we building today?',
  'What\'s on your mind?',
  'Got an idea? Let\'s shape it.',
  'What needs doing next?',
  'Where should we start?',
  'What\'s the next big thing?',
  'Tell me what you want to ship.',
  'What\'s bugging you?',
  'Let\'s turn an idea into tasks.'
] as const

export function pickPlanTagline(random: () => number = Math.random): string {
  return planTaglines[Math.floor(random() * planTaglines.length)]!
}
