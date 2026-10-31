ALTER TYPE "public"."run_outcome" ADD VALUE 'commit_submitted' BEFORE 'findings_reported';--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_outcome_matches_role";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_matches_role" CHECK ("runs"."outcome" is null or case "runs"."role"::text
    when 'developer' then "runs"."outcome"::text in ('pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'findings_reported', 'design_submitted', 'stuck', 'failed', 'rate_limited')
    when 'designer' then "runs"."outcome"::text in ('design_submitted', 'stuck', 'failed', 'rate_limited')
    when 'reviewer' then "runs"."outcome"::text in ('approved', 'changes_requested', 'blocked', 'failed', 'rate_limited')
    else "runs"."outcome"::text in ('failed', 'rate_limited')
  end);