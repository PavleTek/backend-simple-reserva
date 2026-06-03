-- Billing hardening: at most one isActiveSubscription=true row per organization.
-- This partial unique index prevents double-active rows caused by race conditions
-- in activateOrganizationSubscription or concurrent webhook processing.

-- Backfill: deactivate duplicate active rows (keep the best candidate per org).
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

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_org_single_active"
  ON "Subscription"("organizationId")
  WHERE "isActiveSubscription" = true;

-- Add a processing state to WebhookEvent for atomic claim before processing.
-- 'processing' means a worker has claimed the event; differentiates from 'received'.
-- Existing processingStatus check: 'received' | 'processed' | 'failed' | 'skipped' | 'processing'
-- No schema change needed — the column is String and accepts any value.
-- This comment documents the new 'processing' value for posterity.
