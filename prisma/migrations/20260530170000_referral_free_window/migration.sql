-- Ventana de acceso gratis por créditos de referido (agnóstica al método de cobro)
ALTER TABLE "Subscription" ADD COLUMN "referralFreeUntil" TIMESTAMP(3);
