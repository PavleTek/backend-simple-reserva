-- CreateTable
CREATE TABLE "PaymentRegularizationNotice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentRegularizationNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRegularizationRead" (
    "id" TEXT NOT NULL,
    "noticeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT,
    "userEmail" TEXT,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRegularizationRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRegularizationNotice_organizationId_key" ON "PaymentRegularizationNotice"("organizationId");

-- CreateIndex
CREATE INDEX "PaymentRegularizationNotice_enabled_idx" ON "PaymentRegularizationNotice"("enabled");

-- CreateIndex
CREATE INDEX "PaymentRegularizationRead_noticeId_idx" ON "PaymentRegularizationRead"("noticeId");

-- CreateIndex
CREATE INDEX "PaymentRegularizationRead_userId_idx" ON "PaymentRegularizationRead"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRegularizationRead_noticeId_userId_key" ON "PaymentRegularizationRead"("noticeId", "userId");

-- AddForeignKey
ALTER TABLE "PaymentRegularizationNotice" ADD CONSTRAINT "PaymentRegularizationNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRegularizationRead" ADD CONSTRAINT "PaymentRegularizationRead_noticeId_fkey" FOREIGN KEY ("noticeId") REFERENCES "PaymentRegularizationNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRegularizationRead" ADD CONSTRAINT "PaymentRegularizationRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Solo Pilla la Vaca. El aviso queda activo al desplegar; el resto de las cuentas no lo ve.
INSERT INTO "PaymentRegularizationNotice" ("id", "organizationId", "enabled", "createdAt")
SELECT
  'prn_pilla_la_vaca',
  r."organizationId",
  true,
  CURRENT_TIMESTAMP
FROM "Restaurant" r
WHERE r.slug = 'pilla-la-vaca'
  AND r."isDeleted" = false
ON CONFLICT ("organizationId") DO UPDATE
SET "enabled" = true,
    "resolvedAt" = NULL;
