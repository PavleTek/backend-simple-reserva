-- Flags de self-service en ofertas de plan personalizado

ALTER TABLE "CustomPlanOffer" ADD COLUMN IF NOT EXISTS "selfServicePlanChanges" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CustomPlanOffer" ADD COLUMN IF NOT EXISTS "selfServiceBillingStrategyChanges" BOOLEAN NOT NULL DEFAULT true;
