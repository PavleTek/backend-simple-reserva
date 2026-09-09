-- Flow.cl billing provider (per-org). Existing orgs stay on Mercado Pago;
-- new orgs default to Flow.

-- AlterTable RestaurantOrganization
ALTER TABLE "RestaurantOrganization" ADD COLUMN "paymentProvider" TEXT NOT NULL DEFAULT 'mercadopago';
ALTER TABLE "RestaurantOrganization" ADD COLUMN "flowCustomerId" TEXT;
ALTER TABLE "RestaurantOrganization" ADD COLUMN "flowCardBrand" TEXT;
ALTER TABLE "RestaurantOrganization" ADD COLUMN "flowCardLast4" TEXT;
ALTER TABLE "RestaurantOrganization" ADD COLUMN "flowCardRegisteredAt" TIMESTAMP(3);
ALTER TABLE "RestaurantOrganization" ALTER COLUMN "paymentProvider" SET DEFAULT 'flow';

CREATE UNIQUE INDEX "RestaurantOrganization_flowCustomerId_key" ON "RestaurantOrganization"("flowCustomerId");

-- AlterTable Subscription
ALTER TABLE "Subscription" ADD COLUMN "flowSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "flowPlanId" TEXT;

CREATE INDEX "Subscription_flowSubscriptionId_idx" ON "Subscription"("flowSubscriptionId");

-- AlterTable CheckoutSession
ALTER TABLE "CheckoutSession" ADD COLUMN "flowRegisterToken" TEXT;
ALTER TABLE "CheckoutSession" ADD COLUMN "scheduledStartAt" TIMESTAMP(3);

-- AlterTable PaymentReceipt
ALTER TABLE "PaymentReceipt" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'mercadopago';
ALTER TABLE "PaymentReceipt" ADD COLUMN "flowOrder" INTEGER;
ALTER TABLE "PaymentReceipt" ADD COLUMN "flowInvoiceId" TEXT;

CREATE UNIQUE INDEX "PaymentReceipt_flowOrder_key" ON "PaymentReceipt"("flowOrder");

-- AlterTable WebhookEvent
ALTER TABLE "WebhookEvent" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'mercadopago';
