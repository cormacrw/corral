-- Report every offending edge before any DDL. Never repair historical ownership.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(line, E'\n' ORDER BY line) INTO found FROM (
    SELECT format('run %s (project %s) references task %s (project %s)', r.id, r.project_id, t.id, t.project_id) AS line
    FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.project_id <> t.project_id
    UNION ALL
    SELECT format('plan %s (project %s) references session %s (project %s)', p.id, p.project_id, s.id, s.project_id)
    FROM plans p JOIN plan_sessions s ON s.id = p.session_id WHERE p.project_id <> s.project_id
    UNION ALL
    SELECT format('evidence %s (task %s) references criterion %s (task %s)', e.id, e.task_id, c.id, c.task_id)
    FROM evidence e JOIN acceptance_criteria c ON c.id = e.criterion_id WHERE e.task_id IS DISTINCT FROM c.task_id
  ) AS violations;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION E'Ownership violations must be fixed by hand before migrating:\n%', found;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "acceptance_criteria" ADD CONSTRAINT "criteria_task_id_unique" UNIQUE("task_id","id");--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD CONSTRAINT "sessions_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_criterion_requires_task" CHECK ("criterion_id" IS NULL OR "task_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_criterion_id_acceptance_criteria_id_fk";
--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT "plans_session_id_plan_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_criterion_same_task_fk" FOREIGN KEY ("task_id","criterion_id") REFERENCES "public"."acceptance_criteria"("task_id","id") ON DELETE SET NULL ("criterion_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_session_same_project_fk" FOREIGN KEY ("project_id","session_id") REFERENCES "public"."plan_sessions"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_same_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;