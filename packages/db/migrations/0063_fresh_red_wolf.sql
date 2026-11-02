-- A value added by ALTER TYPE can't be used in the transaction that adds it,
-- and every pending migration runs in one transaction. Rebuilding the type can.
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_reason";--> statement-breakpoint
ALTER TYPE "public"."task_status" RENAME TO "task_status_before_parents";--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'backlog', 'ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'merged', 'approved', 'blocked', 'failed', 'parent');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" TYPE "public"."task_status" USING "status"::text::"public"."task_status";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'backlog';--> statement-breakpoint
DROP TYPE "public"."task_status_before_parents";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_reason" CHECK (case when "tasks"."status" in ('blocked', 'failed')
    then "tasks"."status_reason" is not null and btrim("tasks"."status_reason", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') <> ''
    else "tasks"."status_reason" is null end);--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "epics" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "epics" ADD CONSTRAINT "epics_task_same_project_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE SET NULL ("task_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epics" ADD CONSTRAINT "epics_task_id_unique" UNIQUE("task_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_shape" CHECK ("tasks"."status" <> 'parent' or ("tasks"."epic_id" is null and "tasks"."pr_number" is null and "tasks"."lease_run_id" is null));--> statement-breakpoint
-- The merge time of a delivered epic, for sorting its parent in Complete
UPDATE "epics" SET "merged_at" = merged."at"
FROM (
  SELECT "detail"->>'epicId' AS epic_id, max("created_at") AS at FROM "audit_log"
  WHERE "action" = 'epic.pr' AND "detail"->>'event' = 'merged'
  GROUP BY "detail"->>'epicId'
) AS merged
WHERE "epics"."id"::text = merged.epic_id AND "epics"."review_state" = 'merged';--> statement-breakpoint
-- A direct epic has no PR: it landed with its last task
UPDATE "epics" SET "merged_at" = landed."at"
FROM (
  SELECT "epic_id", max("merged_at") AS at FROM "tasks"
  WHERE "epic_id" IS NOT NULL AND "deleted_at" IS NULL
  GROUP BY "epic_id"
  -- As text: a database this far behind adds these values in this transaction
  HAVING bool_and("status"::text = 'merged' OR ("type"::text = 'design' AND "status"::text = 'approved')) AND count(*) > 0
) AS landed
WHERE "epics"."id" = landed.epic_id AND "epics"."merged_at" IS NULL AND ("epics"."review_mode" = 'direct' OR "epics"."branch" IS NULL);--> statement-breakpoint
-- Adds parents only: no branch, PR, review, evidence or existing task's status
-- changes. A one-task epic stays as it is, because tasks_integration_protocol
-- needs its task's epic_id. Deleted tasks don't count.
DO $$
DECLARE
  epic record;
  parent_id uuid;
  parent_number integer;
  body text;
  created integer := 0;
  collapsed integer := 0;
  skipped integer := 0;
BEGIN
  FOR epic IN
    SELECT e.*, (SELECT count(*) FROM "tasks" t WHERE t."epic_id" = e."id" AND t."deleted_at" IS NULL) AS live
    FROM "epics" e ORDER BY e."created_at", e."id"
  LOOP
    IF epic.live = 0 THEN
      skipped := skipped + 1;
    ELSIF epic.live = 1 THEN
      collapsed := collapsed + 1;
    ELSE
      SELECT greatest(p."next_task_number", coalesce((SELECT max(t."number") + 1 FROM "tasks" t WHERE t."project_id" = p."id"), 1))
        INTO parent_number FROM "projects" p WHERE p."id" = epic.project_id;
      UPDATE "projects" SET "next_task_number" = parent_number + 1 WHERE "id" = epic.project_id;
      -- One plain paragraph per line, blank ones included, which is how reads
      -- recognise Markdown
      body := regexp_replace(regexp_replace(epic.description, E'\r\n?', E'\n', 'g'), E'^\\s+|\\s+$', '', 'g');
      INSERT INTO "tasks" ("project_id", "number", "title", "description", "status", "priority", "type", "created_by", "created_at", "updated_at")
      VALUES (
        epic.project_id, parent_number, epic.title,
        CASE WHEN body = '' THEN NULL ELSE jsonb_build_object('type', 'doc', 'content', (
          SELECT jsonb_agg(CASE WHEN line.text ~ E'^\\s*$' THEN jsonb_build_object('type', 'paragraph')
            ELSE jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', line.text))) END ORDER BY line.position)
          FROM unnest(string_to_array(body, E'\n')) WITH ORDINALITY AS line(text, position)
        )) END,
        'parent', epic.priority, 'task', epic.created_by, epic.created_at, epic.updated_at
      ) RETURNING "id" INTO parent_id;
      UPDATE "epics" SET "task_id" = parent_id WHERE "id" = epic.id;
      INSERT INTO "audit_log" ("project_id", "task_id", "actor", "action", "detail", "created_at")
      VALUES (epic.project_id, parent_id, epic.created_by, 'task.created', jsonb_build_object('number', parent_number, 'epicId', epic.id), epic.created_at);
      created := created + 1;
    END IF;
  END LOOP;
  RAISE WARNING 'Parent tasks: % created, % one-task epics collapsed, % empty epics skipped', created, collapsed, skipped;
END $$;
