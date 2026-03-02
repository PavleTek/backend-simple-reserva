-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "mercadopagoPreapprovalId" TEXT;

-- Migrate existing subscriptions: free -> trial, paid -> profesional+active
UPDATE "Subscription" s
SET "plan" = 'profesional',
    "status" = CASE WHEN s."plan" = 'free' THEN 'trial' ELSE 'active' END
WHERE s."plan" IN ('free', 'basic', 'premium', 'pro', 'enterprise');

-- Set trialEndsAt for restaurants with trial subscription (14 days from now)
UPDATE "Restaurant" r
SET "trialEndsAt" = NOW() + INTERVAL '14 days'
FROM "Subscription" s
WHERE s."restaurantId" = r.id AND s."status" = 'trial' AND r."trialEndsAt" IS NULL;

-- AlterTable: set new defaults
ALTER TABLE "Subscription" ALTER COLUMN "plan" SET DEFAULT 'profesional';
ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'trial';
