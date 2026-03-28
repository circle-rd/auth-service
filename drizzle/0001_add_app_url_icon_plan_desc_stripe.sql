-- Migration: add url/icon to applications, description/stripe_product_id to subscription_plans

ALTER TABLE applications ADD COLUMN IF NOT EXISTS url text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS icon text;

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_product_id text;
