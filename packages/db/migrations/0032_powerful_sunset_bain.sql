ALTER TYPE "public"."run_outcome" ADD VALUE 'pr_rebased' BEFORE 'findings_reported';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "rebase_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "approved_head_sha" text;