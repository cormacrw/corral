import type { Comment, Evidence, InboxArtifact, InboxNote } from '@corral/contracts'

// What an Inbox item shows as changed since the human last acted (design/inbox.md).
// Compared by time, never by round: resolving a task resets `reviewRounds`, so
// round numbers repeat. With no action to compare to, everything is new.
export function isNew(createdAt: string, since: string | null): boolean {
  return since === null || createdAt > since
}

// Evidence files, newest first. A `note` has no file, so it isn't an artifact.
export function fileArtifacts(evidence: Evidence[], since: string | null, taskRef: string | null = null): InboxArtifact[] {
  return evidence.flatMap(e => e.kind !== 'note' && e.url && e.fileName && isNew(e.createdAt, since)
    ? [{ id: e.id, kind: e.kind, name: e.fileName, url: e.url, taskRef, at: e.createdAt }]
    : [])
}

// The one-line work notes runs post when they report, oldest first. Other
// agent comments can run to several lines, like a spike's findings.
export function workNotes(comments: Comment[], since: string, taskRef: string | null = null): InboxNote[] {
  return comments
    .filter(c => c.author.kind === 'agent' && ['developer', 'designer'].includes(c.author.role) && !c.pinned && !/[\r\n]/.test(c.body) && c.createdAt > since)
    .map(c => ({ text: c.body, taskRef, at: c.createdAt }))
}
