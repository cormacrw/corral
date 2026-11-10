ALTER TABLE "epics" ALTER COLUMN "review_state" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."epic_review_state";--> statement-breakpoint
CREATE TYPE "public"."epic_review_state" AS ENUM('open', 'in_review', 'human_review', 'changes_requested', 'ready_to_merge', 'merged');--> statement-breakpoint
ALTER TABLE "epics" ALTER COLUMN "review_state" SET DATA TYPE "public"."epic_review_state" USING "review_state"::"public"."epic_review_state";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "state" SET DEFAULT 'queued'::text;--> statement-breakpoint
DROP TYPE "public"."run_state";--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'completed', 'failed', 'interrupted');--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "state" SET DEFAULT 'queued'::"public"."run_state";--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "state" SET DATA TYPE "public"."run_state" USING "state"::"public"."run_state";--> statement-breakpoint
CREATE INDEX "runs_active_number_index" ON "runs" USING btree ("number") WHERE "runs"."state" in ('queued', 'running');--> statement-breakpoint
ALTER TABLE "epics" DROP COLUMN "rebase_requested";--> statement-breakpoint
ALTER TABLE "epics" DROP COLUMN "conflict_files";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ended_at_matches_state" CHECK (("runs"."state" in ('completed', 'failed', 'interrupted')) = ("runs"."ended_at" is not null));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_outcome_only_when_ended" CHECK ("runs"."outcome" is null or "runs"."state" in ('completed', 'failed', 'interrupted'));