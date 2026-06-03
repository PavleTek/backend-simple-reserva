-- Billing hardening: at most one isActiveSubscription=true row per organization.
-- This partial unique index prevents double-active rows caused by race conditions
-- in activateOrganizationSubscription or concurrent webhook processing.
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_org_single_active"
  ON "Subscription"("organizationId")
  WHERE "isActiveSubscription" = true;

-- Add a processing state to WebhookEvent for atomic claim before processing.
-- 'processing' means a worker has claimed the event; differentiates from 'received'.
-- Existing processingStatus check: 'received' | 'processed' | 'failed' | 'skipped' | 'processing'
-- No schema change needed — the column is String and accepts any value.
-- This comment documents the new 'processing' value for posterity.
