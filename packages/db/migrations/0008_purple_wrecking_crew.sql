CREATE TABLE "plan_epics" (
	"plan_id" uuid NOT NULL,
	"epic_id" uuid,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "plan_epics_plan_id_key_pk" PRIMARY KEY("plan_id","key")
);
--> statement-breakpoint
ALTER TABLE "plan_epics" ADD CONSTRAINT "plan_epics_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_epics" ADD CONSTRAINT "plan_epics_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE set null ON UPDATE no action;