-- Plan change tracking, MP card reuse fields, subscription audit log

ALTER TABLE "RestaurantOrganization" ADD COLUMN "mpCustomerId" TEXT,
ADD COLUMN "mpCardId" TEXT;

ALTER TABLE "Subscription" ADD COLUMN "pendingChangeToPlanId" TEXT,
ADD COLUMN "pendingChangePreapprovalId" TEXT,
ADD COLUMN "pendingChangeRequestedAt" TIMESTAMP(3);

ALTER TABLE "CheckoutSession" ADD COLUMN "pendingEndOfPeriodFromSubscriptionId" TEXT;

CREATE INDEX "Subscription_pendingChangePreapprovalId_idx" ON "Subscription"("pendingChangePreapprovalId");

CREATE TABLE "SubscriptionEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionEvent_organizationId_createdAt_idx" ON "SubscriptionEvent"("organizationId", "createdAt");

CREATE INDEX "SubscriptionEvent_subscriptionId_idx" ON "SubscriptionEvent"("subscriptionId");

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionEvent" ADD CONSTRAINT "SubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
