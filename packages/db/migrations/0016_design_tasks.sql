CREATE TYPE "public"."design_version_status" AS ENUM('submitted', 'changes_requested', 'approved', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'design';--> statement-breakpoint
CREATE TABLE "design_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "design_version_status" DEFAULT 'submitted' NOT NULL,
	"bundle_blob" text NOT NULL,
	"spec_blob" text NOT NULL,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"feedback" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_versions_task_version_unique" UNIQUE("task_id","version"),
	CONSTRAINT "design_versions_version_positive" CHECK ("design_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "design_versions" ADD CONSTRAINT "design_versions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;