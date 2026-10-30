-- Stops before changing anything if a row already crosses projects. Those rows
-- need a human's decision, so nothing here rewrites or deletes them. The whole
-- migration is one transaction, so a failure leaves the database as it was.
DO $$
DECLARE
	found text;
BEGIN
	SELECT string_agg(line, E'\n' ORDER BY line) INTO found FROM (
		SELECT format('task %s-%s (%s) is in epic %s (%s, %s)', tp.prefix, t.number, t.id, e.id, e.title, ep.prefix) AS line
		FROM "tasks" t
		JOIN "epics" e ON e.id = t.epic_id AND e.project_id <> t.project_id
		JOIN "projects" tp ON tp.id = t.project_id
		JOIN "projects" ep ON ep.id = e.project_id
		UNION ALL
		SELECT format('task %s-%s (%s) depends on task %s-%s (%s)', ap.prefix, a.number, a.id, bp.prefix, b.number, b.id)
		FROM "task_dependencies" d
		JOIN "tasks" a ON a.id = d.task_id
		JOIN "tasks" b ON b.id = d.depends_on_id AND b.project_id <> a.project_id
		JOIN "projects" ap ON ap.id = a.project_id
		JOIN "projects" bp ON bp.id = b.project_id
		UNION ALL
		SELECT format('epic %s (%s, %s) depends on epic %s (%s, %s)', a.id, a.title, ap.prefix, b.id, b.title, bp.prefix)
		FROM "epic_dependencies" d
		JOIN "epics" a ON a.id = d.epic_id
		JOIN "epics" b ON b.id = d.depends_on_epic_id AND b.project_id <> a.project_id
		JOIN "projects" ap ON ap.id = a.project_id
		JOIN "projects" bp ON bp.id = b.project_id
	) AS crossing;
	IF found IS NOT NULL THEN
		RAISE EXCEPTION E'Cross-project rows must be fixed by hand before this migration can run:\n%', found;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "epics" ADD CONSTRAINT "epics_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
ALTER TABLE "epic_dependencies" DROP CONSTRAINT "epic_dependencies_epic_id_epics_id_fk";--> statement-breakpoint
ALTER TABLE "epic_dependencies" DROP CONSTRAINT "epic_dependencies_depends_on_epic_id_epics_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT "task_dependencies_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_dependencies" DROP CONSTRAINT "task_dependencies_depends_on_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_epic_id_epics_id_fk";--> statement-breakpoint
ALTER TABLE "epic_dependencies" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "epic_dependencies" SET "project_id" = "epics"."project_id" FROM "epics" WHERE "epics"."id" = "epic_dependencies"."epic_id";--> statement-breakpoint
ALTER TABLE "epic_dependencies" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "task_dependencies" SET "project_id" = "tasks"."project_id" FROM "tasks" WHERE "tasks"."id" = "task_dependencies"."task_id";--> statement-breakpoint
ALTER TABLE "task_dependencies" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "epic_dependencies" ADD CONSTRAINT "epic_dependencies_epic_same_project_fk" FOREIGN KEY ("project_id","epic_id") REFERENCES "public"."epics"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_dependencies" ADD CONSTRAINT "epic_dependencies_depends_on_same_project_fk" FOREIGN KEY ("project_id","depends_on_epic_id") REFERENCES "public"."epics"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_same_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_same_project_fk" FOREIGN KEY ("project_id","depends_on_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Only epic_id: a bare SET NULL would also null the required project_id
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_epic_same_project_fk" FOREIGN KEY ("project_id","epic_id") REFERENCES "public"."epics"("project_id","id") ON DELETE SET NULL ("epic_id") ON UPDATE no action;
