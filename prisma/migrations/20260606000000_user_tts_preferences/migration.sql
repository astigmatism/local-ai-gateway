-- Persist authenticated users' active TTS provider and provider-scoped options.

CREATE TABLE "user_tts_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "preference" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_tts_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_tts_preferences_user_id_key" ON "user_tts_preferences"("user_id");
CREATE INDEX "user_tts_preferences_updated_at_idx" ON "user_tts_preferences"("updated_at");

ALTER TABLE "user_tts_preferences" ADD CONSTRAINT "user_tts_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
