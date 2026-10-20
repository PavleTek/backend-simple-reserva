-- AlterTable
ALTER TABLE "PaymentRegularizationNotice" ADD COLUMN "accessUntil" TIMESTAMP(3);

-- Pilla la Vaca: el aviso deja de frenar el corte el viernes 24 de octubre de 2026 a las 23:59 (Chile, UTC-3).
UPDATE "PaymentRegularizationNotice"
SET "accessUntil" = TIMESTAMP '2026-10-25 02:59:59'
WHERE "id" = 'prn_pilla_la_vaca'
  AND "resolvedAt" IS NULL;
