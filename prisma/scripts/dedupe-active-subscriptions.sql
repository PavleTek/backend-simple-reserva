-- One-off: dejar como máximo una fila isActiveSubscription=true por organización.
-- Usar si migrate deploy falló con P3018 / 23505 en Subscription_org_single_active.
-- Luego: npx prisma migrate resolve --rolled-back 20260602000001_billing_hardening_active_unique
--        npx prisma migrate deploy

WITH active_rows AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "organizationId"
      ORDER BY
        CASE status
          WHEN 'active' THEN 1
          WHEN 'grace' THEN 2
          WHEN 'cancelled' THEN 3
          WHEN 'trial' THEN 4
          WHEN 'scheduled' THEN 5
          WHEN 'cancelled_by_admin' THEN 6
          ELSE 7
        END,
        CASE WHEN "mercadopagoPreapprovalId" IS NOT NULL THEN 0 ELSE 1 END,
        "startDate" DESC,
        "createdAt" DESC
    ) AS rn
  FROM "Subscription"
  WHERE "isActiveSubscription" = true
)
UPDATE "Subscription" AS s
SET
  "isActiveSubscription" = false,
  status = CASE
    WHEN s.status IN ('trial', 'active', 'grace', 'scheduled') THEN 'cancelled'
    ELSE s.status
  END
FROM active_rows AS r
WHERE s.id = r.id AND r.rn > 1;
