-- CreateTable
CREATE TABLE "BookingWaitlistEntry" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL,
    "preferredDate" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingWaitlistEntry_restaurantId_createdAt_idx" ON "BookingWaitlistEntry"("restaurantId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingWaitlistEntry" ADD CONSTRAINT "BookingWaitlistEntry_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
