ALTER TABLE "plan_messages" DROP CONSTRAINT "plan_messages_role_kind";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_session_same_project_fk";
--> statement-breakpoint
ALTER TABLE "plan_sessions" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD COLUMN "sender_session_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD COLUMN "sender_title" text;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD COLUMN "pending_action" jsonb;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD COLUMN "parent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_sender_session_id_plan_sessions_id_fk" FOREIGN KEY ("sender_session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_parent_session_id_plan_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_session_id_plan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_messages" ADD CONSTRAINT "plan_messages_role_kind" CHECK (("plan_messages"."role" = 'human' and "plan_messages"."kind" = 'message') or ("plan_messages"."role" = 'thread' and "plan_messages"."kind" in ('message', 'notification')) or ("plan_messages"."role" = 'pm' and "plan_messages"."kind" in ('message', 'question', 'error', 'confirmation', 'action_result'))) NOT VALID;--> statement-breakpoint
-- A global session (null project) can hold plans for any project. A project's
-- session holds only that project's plans, which plans_session_same_project_fk
-- used to enforce; a foreign key can't exempt the global sessions.
CREATE FUNCTION plans_session_same_project() RETURNS trigger AS $$
DECLARE
  session_project uuid;
BEGIN
  SELECT project_id INTO session_project FROM plan_sessions WHERE id = NEW.session_id FOR SHARE;
  IF session_project IS NOT NULL AND session_project <> NEW.project_id THEN
    RAISE EXCEPTION 'plan % (project %) is in session % of project %', NEW.id, NEW.project_id, NEW.session_id, session_project
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'plans_session_same_project_fk';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER plans_session_same_project BEFORE INSERT OR UPDATE OF session_id, project_id ON plans
  FOR EACH ROW EXECUTE FUNCTION plans_session_same_project();
--> statement-breakpoint
CREATE FUNCTION plan_sessions_keep_plans_project() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM plans WHERE session_id = NEW.id AND project_id <> NEW.project_id) THEN
    RAISE EXCEPTION 'session % has plans outside project %', NEW.id, NEW.project_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'plans_session_same_project_fk';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER plan_sessions_keep_plans_project BEFORE UPDATE OF project_id ON plan_sessions
  FOR EACH ROW EXECUTE FUNCTION plan_sessions_keep_plans_project();
