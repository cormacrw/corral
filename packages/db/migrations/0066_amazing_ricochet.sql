CREATE TABLE "pull_request_guides" (
	"project_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"status" text NOT NULL,
	"head_sha" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"generated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_guides_project_id_pr_number_pk" PRIMARY KEY("project_id","pr_number"),
	CONSTRAINT "pull_request_guides_status" CHECK ("pull_request_guides"."status" in ('generating', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "pull_request_guides" ADD CONSTRAINT "pull_request_guides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;