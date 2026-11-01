CREATE TYPE "public"."task_kind" AS ENUM('normal', 'fix', 'conflict');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" "task_kind" DEFAULT 'normal' NOT NULL;