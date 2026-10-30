# Avatar storage

User and agent avatar writes share `AvatarImage` and `storeAvatar` in
`apps/server/src/avatars.ts`: an image contains bytes and an image content
type together; null removes both stored columns. Upload, replacement, cached
URLs and removal retain their existing API behavior.

Migration `0039_chunky_peter_parker.sql` checks both tables under a write lock
before adding `users_avatar_paired` and `agents_avatar_paired`. If either
column alone is null, migration stops with an “Inconsistent avatars” error
listing every affected table and ID, plus presence flags and a repair hint.
It does not delete or repair data. An operator must restore the missing
value (or explicitly remove both values after deciding the image is no longer
needed), then rerun startup/migration. Both-null and both-present rows pass.
The checks reject partial inserts and updates even outside the avatar API.
