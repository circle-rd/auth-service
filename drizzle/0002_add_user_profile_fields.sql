-- Add extra profile fields to the user table
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "phone" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "company" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "position" text;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "address" text;
