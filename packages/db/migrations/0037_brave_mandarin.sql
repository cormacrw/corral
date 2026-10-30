ALTER TABLE "plan_messages" ADD COLUMN "sender_session_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD COLUMN "sender_title" text;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD COLUMN "parent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_sender_session_id_plan_sessions_id_fk" FOREIGN KEY ("sender_session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_parent_session_id_plan_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE set null ON UPDATE no action;