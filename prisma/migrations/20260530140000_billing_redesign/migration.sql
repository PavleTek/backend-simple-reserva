-- Billing redesign: payment method snapshot, provider country, webhooks, addons, cancellations

ALTER TABLE "RestaurantOrganization" ADD COLUMN IF NOT EXISTS "billingCountry" TEXT NOT NULL DEFAULT 'CL';

ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentMethodKind" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentMethodBrand" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentLastFour" TEXT;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentExpirationMonth" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentExpirationYear" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "lastPaymentAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "mpNextRetryAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "isPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "pauseEndsAt" TIMESTAMP(3);

ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "normalizedKind" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebhookEvent" ADD COLUMN IF NOT EXISTS "permanentlyFailed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "WebhookEvent_normalizedKind_idx" ON "WebhookEvent"("normalizedKind");

CREATE TABLE IF NOT EXISTS "SubscriptionCancellation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "reason" TEXT,
    "reasonDetail" TEXT,
    "offeredDowngrade" BOOLEAN NOT NULL DEFAULT false,
    "acceptedRetention" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionCancellation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SubscriptionCancellation_organizationId_idx" ON "SubscriptionCancellation"("organizationId");
CREATE INDEX IF NOT EXISTS "SubscriptionCancellation_reason_idx" ON "SubscriptionCancellation"("reason");
CREATE INDEX IF NOT EXISTS "SubscriptionCancellation_createdAt_idx" ON "SubscriptionCancellation"("createdAt");

ALTER TABLE "SubscriptionCancellation" ADD CONSTRAINT "SubscriptionCancellation_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SubscriptionAddon" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "addonType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priceCLP" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionAddon_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SubscriptionAddon_organizationId_idx" ON "SubscriptionAddon"("organizationId");
CREATE INDEX IF NOT EXISTS "SubscriptionAddon_subscriptionId_idx" ON "SubscriptionAddon"("subscriptionId");
CREATE INDEX IF NOT EXISTS "SubscriptionAddon_addonType_idx" ON "SubscriptionAddon"("addonType");

ALTER TABLE "SubscriptionAddon" ADD CONSTRAINT "SubscriptionAddon_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
