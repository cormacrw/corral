CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "branch_update_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "gate_checks" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "merge_commit_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "merged_at" timestamp with time zone;