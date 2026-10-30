ALTER TYPE "public"."epic_review_state" ADD VALUE 'conflict' BEFORE 'merged';--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "rebase_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "conflict_files" jsonb;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "merge_commit_sha" text;