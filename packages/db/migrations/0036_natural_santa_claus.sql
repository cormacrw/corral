ALTER TABLE "plan_sessions" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "project_id" DROP NOT NULL;