-- CreateTable WebhookEvent: registro persistente de webhooks MP para idempotencia y debugging
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "mpEventType" TEXT NOT NULL,
    "mpDataId" TEXT NOT NULL,
    "mpStatus" TEXT,
    "organizationId" TEXT,
    "externalRef" TEXT,
    "processingStatus" TEXT NOT NULL DEFAULT 'received',
    "errorMessage" TEXT,
    "rawHeaders" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex WebhookEvent
CREATE INDEX "WebhookEvent_organizationId_idx" ON "WebhookEvent"("organizationId");
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
CREATE INDEX "WebhookEvent_processingStatus_idx" ON "WebhookEvent"("processingStatus");
CREATE UNIQUE INDEX "WebhookEvent_mpEventType_mpDataId_key" ON "WebhookEvent"("mpEventType", "mpDataId");

-- AddUniqueConstraint Subscription: evita doble activacion por el mismo preapproval
-- PostgreSQL ignora NULLs en unique constraints, las subs de trial no son afectadas.
CREATE UNIQUE INDEX "Subscription_organizationId_mercadopagoPreapprovalId_key" ON "Subscription"("organizationId", "mercadopagoPreapprovalId");
