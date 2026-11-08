// Who did something. Recorded on every transition and audit entry (D1), so
// nothing here assumes there is only one user.
export type Actor =
  | { kind: 'human', userId: string, viaPm?: { sessionId: string, runId: string } }
  // A PM turn also carries its Plan session
  | { kind: 'agent', role: AgentRole, runId: string, sessionId?: string }
  | { kind: 'system', component: SystemComponent }

export const AGENT_ROLES = ['pm', 'developer', 'designer', 'reviewer'] as const
export type AgentRole = typeof AGENT_ROLES[number]

// A role's name, as the app shows it and agents' prompts use it
export const ROLE_LABELS: Record<AgentRole, string> = { pm: 'PM', developer: 'Developer', designer: 'Designer', reviewer: 'Reviewer' }

// Both live in apps/server; they're told apart so the audit log shows which loop acted
export type SystemComponent = 'scheduler' | 'server'

// The server acting on its own, e.g. after a merge or an integration
export const SERVER_ACTOR: Actor = { kind: 'system', component: 'server' }

// The PM acting, or the human confirming through the PM (D30)
export function isViaPm(actor: Actor): boolean {
  return (actor.kind === 'agent' && actor.role === 'pm') || (actor.kind === 'human' && actor.viaPm !== undefined)
}

// Paused by the human, or waiting out a usage limit (D3)
export function isAgentPaused(agent: { paused: boolean, pausedUntil: Date | string | null }, now: Date): boolean {
  return agent.paused || (agent.pausedUntil !== null && new Date(agent.pausedUntil) > now)
}

// Who wrote something, in the words an agent's prompt uses
export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'human': return 'Human'
    case 'agent': return ROLE_LABELS[actor.role]
    case 'system': return 'Corral'
  }
}

// The actors D10 names in its transition table
export type ActorType = 'human' | 'pm' | 'scheduler' | 'server'

export function actorType(actor: Actor): ActorType | null {
  switch (actor.kind) {
    case 'human': return 'human'
    case 'system': return actor.component
    // Developer and reviewer agents never change status themselves; the
    // server interprets their outcomes (flows.md)
    case 'agent': return actor.role === 'pm' ? 'pm' : null
  }
}
