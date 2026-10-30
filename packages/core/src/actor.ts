// Who did something. Recorded on every transition and audit entry (D1), so
// nothing here assumes there is only one user.
export type Actor =
  | { kind: 'human', userId: string, viaPm?: { sessionId: string, runId: string } }
  | { kind: 'agent', role: AgentRole, runId: string }
  | { kind: 'system', component: SystemComponent }

export const AGENT_ROLES = ['pm', 'developer', 'reviewer'] as const
export type AgentRole = typeof AGENT_ROLES[number]

// Both live in apps/server; they're told apart so the audit log shows which loop acted
export type SystemComponent = 'scheduler' | 'server'

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
