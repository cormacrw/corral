-- D19: task types become task / bug / spike. Every existing task, and every
-- revision staged on a plan, becomes a plain task.
ALTER TABLE "tasks" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
UPDATE "tasks" SET "type" = 'task';--> statement-breakpoint
UPDATE "plan_tasks" SET "revision" = jsonb_set("revision", '{type}', '"task"') WHERE "revision" IS NOT NULL;--> statement-breakpoint
DROP TYPE "public"."task_type";--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('task', 'bug', 'spike');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "type" SET DATA TYPE "public"."task_type" USING "type"::"public"."task_type";
