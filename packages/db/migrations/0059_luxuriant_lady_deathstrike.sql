ALTER TABLE "runs" DROP CONSTRAINT "runs_role_context";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retry_context" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "retry_stop" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_role_context" CHECK (case "runs"."role"::text
    when 'pm' then "runs"."epic_id" is null
    when 'designer' then "runs"."epic_id" is null
    else "runs"."task_id" is null or "runs"."epic_id" is null
  end);