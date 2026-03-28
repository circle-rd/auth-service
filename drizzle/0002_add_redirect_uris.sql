ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "redirect_uris" text[] NOT NULL DEFAULT '{}';
