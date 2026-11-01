-- READ ONLY. What each epic's writer lock is doing, for docs/operations/epic-rollout.md.
-- Lists active operations and those that failed in the last day, newest first.
SELECT p.slug AS project, e.title AS epic, o.kind, o.state, o.error,
       o.expected_target_sha, o.onto_sha, o.result_head_sha, o.runner_id, o.push_attempts,
       o.conflict_files, p.prefix || '-' || COALESCE(r.number, s.number) AS task,
       e.review_state, e.sync_error, o.created_at, o.updated_at
FROM task_integration_operations o
JOIN epics e ON e.id = o.epic_id
JOIN projects p ON p.id = e.project_id
LEFT JOIN tasks r ON r.id = o.resolution_task_id
LEFT JOIN task_submissions ts ON ts.id = o.submission_id
LEFT JOIN tasks s ON s.id = ts.task_id
WHERE o.state IN ('pending', 'running', 'reconciling')
   OR (o.state = 'failed' AND o.updated_at > now() - interval '1 day')
ORDER BY o.updated_at DESC;
