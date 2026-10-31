-- Inspect existing rows before changing the invariant. Never discard or invent evidence.
LOCK TABLE "evidence" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE invalid_ids text;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO invalid_ids
  FROM evidence WHERE NOT ((
    ("evidence"."kind"::text = 'note' and "evidence"."note" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."blob" is null and "evidence"."file_name" is null and "evidence"."content_type" is null and "evidence"."size" = 0)
    or ("evidence"."kind"::text <> 'note' and "evidence"."blob" is not null and "evidence"."blob" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."file_name" is not null and "evidence"."file_name" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."content_type" is not null and "evidence"."content_type" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."size" >= 0)
  ));
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence violates note/file invariant; inspect rows before migrating: %', invalid_ids;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_file_unless_note";--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_note_or_file" CHECK ((
    ("evidence"."kind"::text = 'note' and "evidence"."note" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."blob" is null and "evidence"."file_name" is null and "evidence"."content_type" is null and "evidence"."size" = 0)
    or ("evidence"."kind"::text <> 'note' and "evidence"."blob" is not null and "evidence"."blob" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."file_name" is not null and "evidence"."file_name" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."content_type" is not null and "evidence"."content_type" ~ '[^\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]' and "evidence"."size" >= 0)
  ));