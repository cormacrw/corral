# Audit log

`apps/server/src/audit.ts` is the persistence boundary for `audit_log`. Add an
action or detail key to `AuditDetails` there, then write it with
`appendAudit(tx, scope, auditEvent(action, detail))`. A missing, extra or
misnamed key fails `tsc`, and the server's ESLint config rejects any other
insert, update or delete on the table.

`task.transition` details come from `TransitionDetail`. Human transitions store
the whole input as `event` (`{ type: 'resolve', to: 'ready' }`); every other
producer stores the event's name, so both shapes are current as well as
historical. Rows are never rewritten. Read them with `readAudit`, and name detail
keys in queries with `auditText(action, key)`, which is checked against the
action, instead of writing `detail->>'to'` by hand.

Add new shapes to `readAudit` rather than migrating stored rows.
`GET .../history` still returns details as stored.
