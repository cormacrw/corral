CREATE TYPE "public"."agent_role" AS ENUM('pm', 'developer', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."merge_method" AS ENUM('squash', 'merge', 'rebase');--> statement-breakpoint
CREATE TYPE "public"."run_outcome" AS ENUM('pr_opened', 'pr_updated', 'approved', 'changes_requested', 'stuck', 'failed', 'rate_limited');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'starting', 'running', 'waiting_for_input', 'stopping', 'completed', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('urgent', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'ready', 'in_progress', 'agent_review', 'human_review', 'merged', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('frontend', 'backend', 'full_stack', 'infrastructure');--> statement-breakpoint
CREATE TABLE "acceptance_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" "agent_role" NOT NULL,
	"runtime" text DEFAULT 'claude-code' NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_unique" UNIQUE("name"),
	CONSTRAINT "agents_concurrency_positive" CHECK ("agents"."concurrency" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid,
	"task_id" uuid,
	"actor" jsonb NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author" jsonb NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"prefix" text NOT NULL,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"thumbnail_color" text,
	"thumbnail_blob" text,
	"repository" text NOT NULL,
	"default_branch" text NOT NULL,
	"merge_method" "merge_method" DEFAULT 'squash' NOT NULL,
	"required_checks" text[] DEFAULT '{}'::text[] NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"human_review_default" boolean DEFAULT false NOT NULL,
	"review_round_cap" integer DEFAULT 5 NOT NULL,
	"failed_run_cap" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "projects_repository_unique" UNIQUE("repository"),
	CONSTRAINT "projects_prefix_format" CHECK ("projects"."prefix" ~ '^[A-Z]{2,5}$'),
	CONSTRAINT "projects_caps_positive" CHECK ("projects"."review_round_cap" > 0 and "projects"."failed_run_cap" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "runs_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"role" "agent_role" NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"outcome" "run_outcome",
	"lease_epoch" integer,
	"summary" text,
	"error" text,
	"rate_limit_reset_at" timestamp with time zone,
	"transcript_blob" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "runs_number_unique" UNIQUE("number"),
	CONSTRAINT "runs_task_unless_pm" CHECK ("runs"."task_id" is not null or "runs"."role" = 'pm')
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_id_pk" PRIMARY KEY("task_id","depends_on_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"epic_id" uuid,
	"title" text NOT NULL,
	"description" jsonb,
	"status" "task_status" DEFAULT 'backlog' NOT NULL,
	"priority" "task_priority" DEFAULT 'medium' NOT NULL,
	"type" "task_type" NOT NULL,
	"human_review" boolean DEFAULT false NOT NULL,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"failed_runs" integer DEFAULT 0 NOT NULL,
	"status_reason" text,
	"paused" boolean DEFAULT false NOT NULL,
	"branch" text,
	"pr_number" integer,
	"pr_url" text,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_run_id" uuid,
	"lease_role" "agent_role",
	"lease_acquired_at" timestamp with time zone,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tasks_project_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "tasks_counters_non_negative" CHECK ("tasks"."review_rounds" >= 0 and "tasks"."failed_runs" >= 0 and "tasks"."lease_epoch" >= 0),
	CONSTRAINT "tasks_lease_complete" CHECK (("tasks"."lease_run_id" is null) = ("tasks"."lease_expires_at" is null)
    and ("tasks"."lease_run_id" is null) = ("tasks"."lease_role" is null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "acceptance_criteria_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epics" ADD CONSTRAINT "epics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_id_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lease_run_id_runs_id_fk" FOREIGN KEY ("lease_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acceptance_criteria_task_id_position_index" ON "acceptance_criteria" USING btree ("task_id","position");--> statement-breakpoint
CREATE INDEX "audit_log_task_id_index" ON "audit_log" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "audit_log_project_id_created_at_index" ON "audit_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_task_id_index" ON "comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "epics_project_id_index" ON "epics" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runs_task_id_index" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_agent_id_state_index" ON "runs" USING btree ("agent_id","state");--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_id_index" ON "task_dependencies" USING btree ("depends_on_id");--> statement-breakpoint
CREATE INDEX "tasks_project_id_status_index" ON "tasks" USING btree ("project_id","status");