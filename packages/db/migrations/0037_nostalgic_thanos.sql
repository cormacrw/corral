-- Inspect historical rows before installing constraints. Do not guess a reason
-- or discard PR metadata: an operator must repair any reported rows explicitly.
DO $$
DECLARE invalid_ids text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO invalid_ids
  FROM tasks
  WHERE NOT (CASE WHEN status IN ('blocked', 'failed')
    THEN status_reason IS NOT NULL AND btrim(status_reason, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
    ELSE status_reason IS NULL END)
    OR (pr_number IS NULL) <> (pr_url IS NULL);
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Task metadata preflight failed. Repair status reasons or PR pairs for task IDs: %', invalid_ids;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_reason" CHECK (case when "tasks"."status" in ('blocked', 'failed')
    then "tasks"."status_reason" is not null and btrim("tasks"."status_reason", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
    else "tasks"."status_reason" is null end);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_pr_complete" CHECK (("tasks"."pr_number" is null) = ("tasks"."pr_url" is null));