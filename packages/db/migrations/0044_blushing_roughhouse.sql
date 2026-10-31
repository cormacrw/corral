-- Inspect history before DDL; preserve it and enforce checks on future writes.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(line, E'\n' ORDER BY line) INTO found FROM (
    SELECT format('message %s (session %s): role=%s kind=%s', id, session_id, role, kind) AS line
    FROM plan_messages
    WHERE NOT ((role = 'human' AND kind = 'message') OR (role = 'pm' AND kind IN ('message', 'question', 'error')))
       OR NOT (kind = 'question' OR (recommendation IS NULL AND options IS NULL))
  ) AS violations;
  IF found IS NOT NULL THEN
    RAISE WARNING E'Historical plan message violations (preserved):\n%', found;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_role_kind" CHECK (("plan_messages"."role" = 'human' and "plan_messages"."kind" = 'message') or ("plan_messages"."role" = 'pm' and "plan_messages"."kind" in ('message', 'question', 'error'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_question_fields" CHECK ("plan_messages"."kind" = 'question' or ("plan_messages"."recommendation" is null and "plan_messages"."options" is null)) NOT VALID;