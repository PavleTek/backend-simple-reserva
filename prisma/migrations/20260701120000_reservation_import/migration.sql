-- CreateTable
CREATE TABLE "ReservationImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "source" TEXT NOT NULL DEFAULT 'csv',
    "fileKey" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "validatedFileKey" TEXT,
    "columnMapping" JSONB,
    "options" JSONB,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "errorReportKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "rollbackAvailableUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationImport_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "importId" TEXT;

-- CreateIndex
CREATE INDEX "ReservationImport_organizationId_idx" ON "ReservationImport"("organizationId");

-- CreateIndex
CREATE INDEX "ReservationImport_restaurantId_status_idx" ON "ReservationImport"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "ReservationImport_status_idx" ON "ReservationImport"("status");

-- CreateIndex
CREATE INDEX "Reservation_importId_idx" ON "Reservation"("importId");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ReservationImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
