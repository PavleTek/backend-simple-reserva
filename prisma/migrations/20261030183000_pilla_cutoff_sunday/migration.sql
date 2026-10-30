-- Pilla la Vaca: el aviso vuelve a mostrarse y el acceso se apaga
-- el domingo 1 de noviembre de 2026 a las 23:59, hora de Chile (UTC-3).
UPDATE "PaymentRegularizationNotice" AS n
SET
  "enabled" = true,
  "resolvedAt" = NULL,
  "accessUntil" = TIMESTAMP '2026-11-02 02:59:59'
FROM "Restaurant" AS r
WHERE r.slug = 'pilla-la-vaca'
  AND r."isDeleted" = false
  AND n."organizationId" = r."organizationId";

UPDATE "Subscription" AS s
SET "gracePeriodEndsAt" = TIMESTAMP '2026-11-02 02:59:59'
FROM "Restaurant" AS r
WHERE r.slug = 'pilla-la-vaca'
  AND r."isDeleted" = false
  AND s."organizationId" = r."organizationId"
  AND s."flowSubscriptionId" IS NOT NULL
  AND s."isActiveSubscription" = true
  AND s.status = 'grace';
