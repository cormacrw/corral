CREATE TYPE "public"."task_kind" AS ENUM('normal', 'fix', 'conflict');--> statement-breakpoint
CREATE TABLE "epic_review_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"epic_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"head_sha" text NOT NULL,
	"verdict" "review_verdict" NOT NULL,
	"summary" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epic_review_round_positive" CHECK ("epic_review_rounds"."round" > 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_reviewer_id_agents_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epic_review_rounds_epic_id_round_index" ON "epic_review_rounds" USING btree ("epic_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "epic_review_rounds_run_id_index" ON "epic_review_rounds" USING btree ("run_id");--> statement-breakpoint
-- Tasks from before `kind`. A conflict task ran on the epic's own branch or a
-- rebase candidate, which nothing else does. Fix tasks have only their title to
-- go on, so a human's task in an epic titled the same way reads as one: it's a
-- label on the Tasks tab, and neither behaviour nor status depends on it.
UPDATE "tasks" SET "kind" = 'conflict' FROM "epics" WHERE "tasks"."epic_id" = "epics"."id" AND ("tasks"."branch" LIKE 'corral/epic-rebase/%' OR ("tasks"."title" LIKE 'Rebase epic:%' AND "tasks"."branch" = "epics"."branch"));--> statement-breakpoint
UPDATE "tasks" SET "kind" = 'fix' WHERE "epic_id" IS NOT NULL AND "kind" = 'normal' AND ("title" LIKE 'Fix integration:%' OR "title" LIKE 'CI failed:%');
