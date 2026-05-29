-- Billing SaaS domain: billingStrategy + PSP paymentProvider + scheduled plan change

-- Subscription: new domain columns
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "billingStrategy" TEXT NOT NULL DEFAULT 'automatic_recurring';
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "providerImplementation" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "scheduledPlanId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "scheduledChangeAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "planChangeWhen" TEXT;

-- Backfill from legacy paymentProvider values (mercadopago_preapproval | mp_checkout_pro)
UPDATE "Subscription"
SET
  "billingStrategy" = 'manual_monthly',
  "providerImplementation" = 'checkout_pro',
  "paymentProvider" = 'mercadopago'
WHERE "paymentProvider" = 'mp_checkout_pro';

UPDATE "Subscription"
SET
  "billingStrategy" = 'automatic_recurring',
  "providerImplementation" = 'preapproval',
  "paymentProvider" = 'mercadopago'
WHERE "paymentProvider" = 'mercadopago_preapproval'
   OR ("paymentProvider" NOT IN ('mercadopago') AND "providerImplementation" IS NULL);

-- CheckoutSession: billing strategy columns
ALTER TABLE "CheckoutSession" ADD COLUMN IF NOT EXISTS "billingStrategy" TEXT NOT NULL DEFAULT 'automatic_recurring';
ALTER TABLE "CheckoutSession" ADD COLUMN IF NOT EXISTS "providerImplementation" TEXT;

UPDATE "CheckoutSession"
SET
  "billingStrategy" = 'manual_monthly',
  "providerImplementation" = 'checkout_pro',
  "paymentProvider" = 'mercadopago'
WHERE "paymentProvider" = 'mp_checkout_pro';

UPDATE "CheckoutSession"
SET
  "billingStrategy" = 'automatic_recurring',
  "providerImplementation" = 'preapproval',
  "paymentProvider" = 'mercadopago'
WHERE "paymentProvider" = 'mercadopago_preapproval'
   OR ("paymentProvider" NOT IN ('mercadopago') AND "providerImplementation" IS NULL);

-- FK scheduled plan
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_scheduledPlanId_fkey"
  FOREIGN KEY ("scheduledPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Subscription_scheduledChangeAt_idx" ON "Subscription"("scheduledChangeAt");
