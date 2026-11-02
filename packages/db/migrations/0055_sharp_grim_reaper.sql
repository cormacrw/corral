ALTER TABLE "task_integration_operations" ALTER COLUMN "submission_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "sync_retried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "onto_sha" text;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "resolution_task_id" uuid;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "conflict_files" jsonb;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD COLUMN "push_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD CONSTRAINT "task_integration_operations_resolution_task_id_tasks_id_fk" FOREIGN KEY ("resolution_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_integration_operations" ADD CONSTRAINT "task_integration_operation_subject" CHECK (("task_integration_operations"."kind" = 'integrate') = ("task_integration_operations"."submission_id" is not null) and ("task_integration_operations"."kind" = 'rebase') = ("task_integration_operations"."onto_sha" is not null));