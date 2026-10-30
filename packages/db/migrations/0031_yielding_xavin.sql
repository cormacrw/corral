ALTER TABLE "perf_samples" ADD COLUMN "metric" text;--> statement-breakpoint
ALTER TABLE "perf_samples" ADD COLUMN "session_id" uuid;