ALTER TABLE "agents" ADD COLUMN "avatar_blob" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "avatar_content_type" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_blob" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_content_type" text;