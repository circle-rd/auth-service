-- Migration 0003: Add subscription_plan_prices table
CREATE TABLE IF NOT EXISTS "subscription_plan_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid NOT NULL REFERENCES "subscription_plans"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "amount" numeric NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "interval" text NOT NULL DEFAULT 'month',
  "stripe_price_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
