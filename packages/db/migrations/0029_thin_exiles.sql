CREATE TYPE "public"."deployment_notes_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_sha" text,
	"to_sha" text NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"notes_status" "deployment_notes_status" DEFAULT 'pending' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployments_project_to_sha_unique" UNIQUE("project_id","to_sha")
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;