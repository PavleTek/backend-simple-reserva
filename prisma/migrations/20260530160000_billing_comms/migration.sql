-- CreateTable
CREATE TABLE "BillingEmailLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "BillingEmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingOpsAlert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "suggestedAction" TEXT,
    "mpPaymentId" TEXT,
    "mpStatus" TEXT,
    "mpStatusDetail" TEXT,
    "checkoutSessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "BillingOpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingEmailLog_organizationId_idx" ON "BillingEmailLog"("organizationId");

-- CreateIndex
CREATE INDEX "BillingEmailLog_sentAt_idx" ON "BillingEmailLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEmailLog_subscriptionId_kind_periodKey_key" ON "BillingEmailLog"("subscriptionId", "kind", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOpsAlert_dedupeKey_key" ON "BillingOpsAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "BillingOpsAlert_organizationId_idx" ON "BillingOpsAlert"("organizationId");

-- CreateIndex
CREATE INDEX "BillingOpsAlert_status_idx" ON "BillingOpsAlert"("status");

-- CreateIndex
CREATE INDEX "BillingOpsAlert_severity_idx" ON "BillingOpsAlert"("severity");

-- CreateIndex
CREATE INDEX "BillingOpsAlert_createdAt_idx" ON "BillingOpsAlert"("createdAt");

-- AddForeignKey
ALTER TABLE "BillingEmailLog" ADD CONSTRAINT "BillingEmailLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEmailLog" ADD CONSTRAINT "BillingEmailLog_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOpsAlert" ADD CONSTRAINT "BillingOpsAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingOpsAlert" ADD CONSTRAINT "BillingOpsAlert_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
