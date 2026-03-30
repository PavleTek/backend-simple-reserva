-- AlterTable Subscription: fin de periodo persistido
ALTER TABLE "Subscription" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);

-- AlterTable CheckoutSession: intención de cambio de plan inmediato
ALTER TABLE "CheckoutSession" ADD COLUMN "pendingChangeFromSubscriptionId" TEXT;

CREATE INDEX "Subscription_currentPeriodEnd_idx" ON "Subscription"("currentPeriodEnd");
CREATE INDEX "CheckoutSession_pendingChangeFromSubscriptionId_idx" ON "CheckoutSession"("pendingChangeFromSubscriptionId");
