-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN "confirmedByUserId" TEXT,
ADD COLUMN "updatedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "Reservation_confirmedByUserId_idx" ON "Reservation"("confirmedByUserId");

-- CreateIndex
CREATE INDEX "Reservation_updatedByUserId_idx" ON "Reservation"("updatedByUserId");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
