CREATE TABLE "perf_samples" (
	"metric" text,
	"session_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status" integer,
	"query_count" integer,
	"db_time_ms" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "perf_samples_kind_created_at_idx" ON "perf_samples" USING btree ("kind","created_at");