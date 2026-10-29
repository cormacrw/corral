CREATE TYPE "public"."epic_review_mode" AS ENUM('epic', 'each_task', 'direct');--> statement-breakpoint
CREATE TYPE "public"."epic_review_state" AS ENUM('open', 'in_review', 'human_review', 'changes_requested', 'merged');--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "review_mode" "epic_review_mode" DEFAULT 'epic' NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "pr_head_sha" text;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "review_state" "epic_review_state";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "epic_review_mode_default" "epic_review_mode" DEFAULT 'epic' NOT NULL;--> statement-breakpoint
-- Epics already under way keep today's behaviour (D23): any epic with a task
-- on the board (not deleted, outside Draft and Backlog) merges straight into
-- the target branch. That includes epics whose board tasks have all merged,
-- which are done and have no epic branch to wait for.
UPDATE "epics" SET "review_mode" = 'direct' WHERE EXISTS (SELECT 1 FROM "tasks" WHERE "tasks"."epic_id" = "epics"."id" AND "tasks"."deleted_at" IS NULL AND "tasks"."status" NOT IN ('draft', 'backlog'));
