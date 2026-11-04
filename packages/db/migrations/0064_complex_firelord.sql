CREATE TABLE "inbox_reads" (
	"key" text PRIMARY KEY NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
