-- READ ONLY. Run against the intended database for human review before any repair.
-- All design tasks are listed, including deleted ones; no status is inferred or changed.
SELECT p.slug AS project, p.prefix || '-' || t.number AS ref, t.id, t.status,
       t.deleted_at, v.version AS approved_version, v.id AS approved_version_id,
       v.commit_sha, v.updated_at AS version_updated_at,
       CASE
         WHEN t.deleted_at IS NOT NULL THEN 'leave deleted; preserve versions'
         WHEN t.status = 'approved' THEN 'no repair; already Approved'
         WHEN v.id IS NULL THEN 'no repair; no approved version'
         WHEN t.status = 'in_progress' THEN 'review: may be intentionally reopened; do not auto-repair'
         ELSE 'review separately: approved version with legacy task status; do not auto-repair'
       END AS migration_policy
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN LATERAL (
  SELECT id, version, commit_sha, updated_at FROM design_versions
  WHERE task_id = t.id AND status = 'approved'
  ORDER BY version DESC LIMIT 1
) v ON true
WHERE t.type = 'design'
ORDER BY p.slug, t.number;
