CREATE TABLE "epic_dependencies" (
	"epic_id" uuid NOT NULL,
	"depends_on_epic_id" uuid NOT NULL,
	CONSTRAINT "epic_dependencies_epic_id_depends_on_epic_id_pk" PRIMARY KEY("epic_id","depends_on_epic_id"),
	CONSTRAINT "epic_dependencies_not_self" CHECK ("epic_dependencies"."epic_id" <> "epic_dependencies"."depends_on_epic_id")
);
--> statement-breakpoint
ALTER TABLE "epic_dependencies" ADD CONSTRAINT "epic_dependencies_epic_id_epics_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epic_dependencies" ADD CONSTRAINT "epic_dependencies_depends_on_epic_id_epics_id_fk" FOREIGN KEY ("depends_on_epic_id") REFERENCES "public"."epics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "epic_dependencies_depends_on_epic_id_index" ON "epic_dependencies" USING btree ("depends_on_epic_id");