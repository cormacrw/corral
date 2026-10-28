CREATE TYPE "public"."evidence_kind" AS ENUM('screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other');--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"criterion_id" uuid,
	"run_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"blob" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_criterion_id_acceptance_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."acceptance_criteria"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_task_id_round_index" ON "evidence" USING btree ("task_id","round");