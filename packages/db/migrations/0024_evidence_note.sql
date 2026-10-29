ALTER TYPE "public"."evidence_kind" ADD VALUE 'note';--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "blob" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "file_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ALTER COLUMN "content_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_file_unless_note" CHECK ("evidence"."kind"::text = 'note' or ("evidence"."blob" is not null and "evidence"."file_name" is not null and "evidence"."content_type" is not null));