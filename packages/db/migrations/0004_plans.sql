CREATE TYPE "public"."plan_change" AS ENUM('added', 'changed', 'unchanged', 'removed');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('proposed', 'approved', 'superseded');--> statement-breakpoint
CREATE TABLE "plan_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"text" text NOT NULL,
	"plan_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"agent_session_id" text,
	"unread" boolean DEFAULT false NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_tasks" (
	"plan_id" uuid NOT NULL,
	"task_id" uuid,
	"key" text NOT NULL,
	"change" "plan_change" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "plan_tasks_plan_id_key_pk" PRIMARY KEY("plan_id","key")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"epic_id" uuid,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" "plan_status" DEFAULT 'proposed' NOT NULL,
	"approved_by" jsonb,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_session_version_unique" UNIQUE("session_id","version")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "plan_session_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_session_id_plan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_session_id_plan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_messages_session_id_created_at_index" ON "plan_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "plan_sessions_project_id_updated_at_index" ON "plan_sessions" USING btree ("project_id","updated_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_plan_session_id_plan_sessions_id_fk" FOREIGN KEY ("plan_session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE set null ON UPDATE no action;