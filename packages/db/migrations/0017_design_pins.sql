CREATE TABLE "task_design_pins" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"design_version_id" uuid NOT NULL,
	"screens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_design_pins" ADD CONSTRAINT "task_design_pins_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_design_pins" ADD CONSTRAINT "task_design_pins_design_version_id_design_versions_id_fk" FOREIGN KEY ("design_version_id") REFERENCES "public"."design_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_design_pins_design_version_id_index" ON "task_design_pins" USING btree ("design_version_id");