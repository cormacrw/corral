-- Stops rather than rewrites: each row below needs a human to decide what it
-- should have been. Conditions match the checks added after this, and the
-- comparison is `is false` because a check only rejects false, not null.
DO $$
DECLARE
  total integer;
  listing text;
BEGIN
  WITH broken AS (
    SELECT r.number, r.id, r.role, r.state, r.outcome, r.task_id, r.epic_id, r.ended_at, c.name
    FROM runs r
    CROSS JOIN LATERAL (VALUES
      ('runs_role_context', (case r.role
        when 'pm' then r.task_id is null and r.epic_id is null
        when 'developer' then r.epic_id is null
        else r.task_id is null or r.epic_id is null
      end)),
      ('runs_ended_at_matches_state', ((r.state in ('completed', 'failed', 'interrupted')) = (r.ended_at is not null))),
      ('runs_outcome_only_when_ended', (r.outcome is null or r.state in ('completed', 'failed', 'interrupted'))),
      ('runs_outcome_matches_role', (r.outcome is null or case r.role
        when 'developer' then r.outcome::text in ('pr_opened', 'pr_updated', 'pr_rebased', 'findings_reported', 'design_submitted', 'stuck', 'failed', 'rate_limited')
        when 'reviewer' then r.outcome::text in ('approved', 'changes_requested', 'blocked', 'failed', 'rate_limited')
        else r.outcome::text in ('failed', 'rate_limited')
      end))
    ) AS c(name, ok)
    WHERE c.ok IS FALSE
  )
  SELECT count(*),
    string_agg(format('run #%s (%s): %s, role=%s state=%s outcome=%s task=%s epic=%s ended_at=%s', number, id, name, role, state, coalesce(outcome::text, 'null'), coalesce(task_id::text, 'null'), coalesce(epic_id::text, 'null'), coalesce(ended_at::text, 'null')), E'\n' ORDER BY number)
  INTO total, listing
  FROM broken;
  IF total > 0 THEN
    RAISE EXCEPTION E'% check violation(s) in runs. Nothing was changed; fix these rows, then migrate again:\n%', total, listing;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_role_context" CHECK (case "runs"."role"
    when 'pm' then "runs"."task_id" is null and "runs"."epic_id" is null
    when 'developer' then "runs"."epic_id" is null
    else "runs"."task_id" is null or "runs"."epic_id" is null
  end);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ended_at_matches_state" CHECK (("runs"."state" in ('completed', 'failed', 'interrupted')) = ("runs"."ended_at" is not null));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_only_when_ended" CHECK ("runs"."outcome" is null or "runs"."state" in ('completed', 'failed', 'interrupted'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_matches_role" CHECK ("runs"."outcome" is null or case "runs"."role"
    when 'developer' then "runs"."outcome"::text in ('pr_opened', 'pr_updated', 'pr_rebased', 'findings_reported', 'design_submitted', 'stuck', 'failed', 'rate_limited')
    when 'reviewer' then "runs"."outcome"::text in ('approved', 'changes_requested', 'blocked', 'failed', 'rate_limited')
    else "runs"."outcome"::text in ('failed', 'rate_limited')
  end);