CREATE TABLE "task_integration_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expected_target_sha" text NOT NULL,
	"result_head_sha" text,
	"runner_id" text,
	"lease_epoch" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_integration_operation_kind" CHECK ("task_integration_operations"."kind" in ('integrate', 'rebase')),
	CONSTRAINT "task_integration_operation_state" CHECK ("task_integration_operations"."state" in ('pending', 'running', 'reconciling', 'succeeded', 'failed')),
	CONSTRAINT "task_integration_operation_epoch" CHECK ("task_integration_operations"."lease_epoch" >= 0),
	CONSTRAINT "task_integration_operation_result" CHECK ("task_integration_operations"."state" <> 'succeeded' or "task_integration_operations"."result_head_sha" is not null)
);
--> statement-breakpoint
CREATE TABLE "task_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"protocol" integer DEFAULT 1 NOT NULL,
	"branch" text NOT NULL,
	"submitted_head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"target_branch" text NOT NULL,
	"agent_approved_head_sha" text,
	"integrated_commit_sha" text,
	"integrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_submissions_taskId_sequence_unique" UNIQUE("task_id","sequence"),
	CONSTRAINT "task_submissions_positive_version" CHECK ("task_submissions"."sequence" > 0 and "task_submissions"."protocol" > 0),
	CONSTRAINT "task_submissions_approval_matches_head" CHECK ("task_submissions"."agent_approved_head_sha" is null or "task_submissions"."agent_approved_head_sha" = "task_submissions"."submitted_head_sha"),
	CONSTRAINT "task_submissions_integration_complete" CHECK (("task_submissions"."integrated_commit_sha" is null) = ("task_submissions"."integrated_at" is null) and ("task_submissions"."integrated_commit_sha" is null or "task_submissions"."agent_approved_head_sha" is not null))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "integration_protocol" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD CONSTRAINT "task_integration_operations_submission_id_task_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."task_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_submissions" ADD CONSTRAINT "task_submissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_integration_operations_submission_id_index" ON "task_integration_operations" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_integration_one_active_operation" ON "task_integration_operations" USING btree ("submission_id") WHERE "task_integration_operations"."state" in ('pending', 'running', 'reconciling');--> statement-breakpoint
CREATE INDEX "task_submissions_task_id_index" ON "task_submissions" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_integration_protocol" CHECK ("tasks"."integration_protocol" >= 0 and ("tasks"."integration_protocol" = 0 or ("tasks"."pr_number" is null and "tasks"."epic_id" is not null and "tasks"."type"::text in ('task', 'bug'))));