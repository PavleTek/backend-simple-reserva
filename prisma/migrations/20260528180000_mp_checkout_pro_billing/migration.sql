-- Mercado Pago Checkout Pro: paymentProvider en Subscription y CheckoutSession

ALTER TABLE "Subscription" ADD COLUMN "paymentProvider" TEXT NOT NULL DEFAULT 'mercadopago_preapproval';
ALTER TABLE "Subscription" ADD COLUMN "providerCheckoutSessionId" TEXT;

ALTER TABLE "CheckoutSession" ADD COLUMN "mercadopagoPreferenceId" TEXT;
ALTER TABLE "CheckoutSession" ADD COLUMN "paymentProvider" TEXT NOT NULL DEFAULT 'mercadopago_preapproval';
