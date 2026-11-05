# Avatar storage

User and agent avatar writes share `AvatarImage` and `storeAvatar` in
`apps/server/src/avatars.ts`: an image contains bytes and an image content
type together; null removes both stored columns. Upload, replacement, cached
URLs and removal retain their existing API behavior.

Migration `0048_chunky_peter_parker.sql` checks both tables under a write lock
before adding `users_avatar_paired` and `agents_avatar_paired`. If either
column alone is null, migration stops with an “Inconsistent avatars” error
listing every affected table and ID, plus presence flags and a repair hint.
It does not delete or repair data. An operator must restore the missing
value (or explicitly remove both values after deciding the image is no longer
needed), then rerun startup/migration. Both-null and both-present rows pass.
The checks reject partial inserts and updates even outside the avatar API.

## Who an activity entry shows

`AgentAvatar` finds a picture by the agent's name, but audit actors store only
a role and a run. `actorNames` (`apps/server/src/actor-names.ts`) resolves
them the way the project overview does: the PM by its role (also for an
action the human confirmed through the PM), other agents by their run's
agent. Task and epic history return it as `AuditEntry.agentName`, and the
Inbox uses it for task and epic event senders, as the parent History panel does for agents. When the agent can't be found
the entry shows the role label ("Developer") with initials; a PM-confirmed
action reads "Juno · confirmed by you", with only the name on the avatar.
