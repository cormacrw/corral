ALTER TABLE "runs" ADD COLUMN "review" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conflicted_files" jsonb;