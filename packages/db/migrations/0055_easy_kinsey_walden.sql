ALTER TABLE "epics" ADD COLUMN "approved_head_sha" text;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "approved_base_sha" text;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "resolution_review" jsonb;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "decisions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- An approved epic's head is the commit it was approved on, so approvals in flight survive a rebase
UPDATE "epics" SET "approved_head_sha" = "pr_head_sha" WHERE "review_state" IN ('human_review', 'ready_to_merge', 'conflict');
