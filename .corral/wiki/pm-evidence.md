# PM evidence attachments

PM sessions expose `attach_evidence` with the same file kinds, notes, 25 MB limit
and scratch-directory checks as developer runs. Absolute paths and paths relative
to scratch work; paths and symlinks that resolve outside scratch are rejected.

Omit `taskRef` to post a downloadable file link (or a written note) in the Plan
conversation. The chat message is published live and retained in session history.
Supply a project task ref to add evidence to that task's current review round;
`criterionId`, when supplied, must belong to that task. Refs from other projects
and deleted tasks are refused. Chat files use the existing immutable evidence
blob/download flow with a null task ID, owned by their PM run.
