ALTER TABLE "runs" DROP CONSTRAINT "runs_task_unless_pm";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_role_context";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "fix_kind" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "behaviour_changed" boolean;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "re_reviewed" boolean;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ci_fix" jsonb;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "fix" text;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "fix_brief" text;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "fix_checks" jsonb;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "fix_report" jsonb;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "fix_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_unless_pm" CHECK ("runs"."task_id" is not null or "runs"."role" = 'pm' or ("runs"."epic_id" is not null and "runs"."role" in ('reviewer', 'developer')));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_role_context" CHECK (case "runs"."role"::text
    when 'pm' then "runs"."task_id" is null and "runs"."epic_id" is null
    when 'designer' then "runs"."epic_id" is null
    else "runs"."task_id" is null or "runs"."epic_id" is null
  end);