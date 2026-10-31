-- Inspect history before DDL; preserve it and enforce checks on future writes.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(line, E'\n' ORDER BY line) INTO found FROM (
    SELECT format('plan %s (session %s): status=%s approved_by=%s approved_at=%s', id, session_id, status, approved_by, approved_at) AS line
    FROM plans
    WHERE NOT ((approved_by IS NULL) = (approved_at IS NULL)
      AND (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)))
    UNION ALL
    SELECT format('plan-task %s (plan %s): change=%s has revision', key, plan_id, change)
    FROM plan_tasks WHERE revision IS NOT NULL AND change NOT IN ('added', 'changed', 'unchanged')
  ) AS violations;
  IF found IS NOT NULL THEN
    RAISE WARNING E'Historical plan approval/staged task violations (preserved):\n%', found;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_revision_change" CHECK ("plan_tasks"."revision" is null or "plan_tasks"."change" in ('added', 'changed', 'unchanged')) NOT VALID;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_approval_tuple" CHECK (("plans"."approved_by" is null) = ("plans"."approved_at" is null) and ("plans"."status" <> 'approved' or ("plans"."approved_by" is not null and "plans"."approved_at" is not null))) NOT VALID;