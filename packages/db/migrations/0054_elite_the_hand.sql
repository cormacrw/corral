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
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_review_rounds" ADD CONSTRAINT "epic_review_rounds_reviewer_id_agents_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "epic_review_rounds_epic_id_round_index" ON "epic_review_rounds" USING btree ("epic_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "epic_review_rounds_run_id_index" ON "epic_review_rounds" USING btree ("run_id");