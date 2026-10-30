-- Hold writes until the preflight and constraints complete in the migrator's transaction.
LOCK TABLE users, agents IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  inconsistent jsonb;
BEGIN
  SELECT jsonb_agg(row_to_json(bad) ORDER BY bad.owner, bad.id) INTO inconsistent
  FROM (
    SELECT 'users' AS owner, id,
      avatar_blob IS NOT NULL AS has_image,
      avatar_content_type IS NOT NULL AS has_content_type
    FROM users
    WHERE (avatar_blob IS NULL) <> (avatar_content_type IS NULL)
    UNION ALL
    SELECT 'agents' AS owner, id,
      avatar_blob IS NOT NULL AS has_image,
      avatar_content_type IS NOT NULL AS has_content_type
    FROM agents
    WHERE (avatar_blob IS NULL) <> (avatar_content_type IS NULL)
  ) bad;
  IF inconsistent IS NOT NULL THEN
    RAISE EXCEPTION 'Inconsistent avatars: %', inconsistent
      USING HINT = 'Repair the listed users and agents so avatar_blob and avatar_content_type are both null or both present, then rerun the migration. No avatars have been changed.';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_avatar_paired" CHECK (("agents"."avatar_blob" is null) = ("agents"."avatar_content_type" is null));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_paired" CHECK (("users"."avatar_blob" is null) = ("users"."avatar_content_type" is null));