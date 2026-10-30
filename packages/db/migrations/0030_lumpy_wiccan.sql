ALTER TYPE "public"."epic_review_state" ADD VALUE 'ready_to_merge' BEFORE 'merged';--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_task_unless_pm";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "epic_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_epic_id_index" ON "runs" USING btree ("epic_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_unless_pm" CHECK ("runs"."task_id" is not null or "runs"."role" = 'pm' or ("runs"."epic_id" is not null and "runs"."role" = 'reviewer'));