-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "isActiveSubscription" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Subscription_isActiveSubscription_idx" ON "Subscription"("isActiveSubscription");
