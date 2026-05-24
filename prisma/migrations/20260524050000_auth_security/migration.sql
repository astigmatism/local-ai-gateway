-- Add authentication and session fields while preserving existing users and conversation data.

ALTER TABLE "users" ADD COLUMN "login_name" TEXT;
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "failed_login_window_started_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "locked_until" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

WITH normalized_base AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        LOWER(
          REGEXP_REPLACE(
            REGEXP_REPLACE(TRIM("display_name"), '[^a-zA-Z0-9]+', '_', 'g'),
            '^_+|_+$',
            '',
            'g'
          )
        ),
        ''
      ),
      'user'
    ) AS base_login_name,
    "created_at"
  FROM "users"
),
normalized_users AS (
  SELECT
    "id",
    base_login_name,
    ROW_NUMBER() OVER (
      PARTITION BY base_login_name
      ORDER BY "created_at", "id"
    ) AS duplicate_index
  FROM normalized_base
)
UPDATE "users" AS u
SET "login_name" = n.base_login_name || CASE WHEN n.duplicate_index = 1 THEN '' ELSE '_' || n.duplicate_index::TEXT END
FROM normalized_users AS n
WHERE u."id" = n."id";

ALTER TABLE "users" ALTER COLUMN "login_name" SET NOT NULL;

WITH first_eric AS (
  SELECT "id"
  FROM "users"
  WHERE LOWER("display_name") = 'eric'
  ORDER BY "created_at", "id"
  LIMIT 1
)
UPDATE "users" AS u
SET "is_admin" = true,
    "is_active" = true,
    "deleted_at" = NULL
FROM first_eric
WHERE u."id" = first_eric."id";

CREATE UNIQUE INDEX "users_login_name_key" ON "users"("login_name");
CREATE INDEX "users_is_active_deleted_at_idx" ON "users"("is_active", "deleted_at");

CREATE TABLE "auth_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "csrf_token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "user_agent" TEXT,
  "ip_address" TEXT,

  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
