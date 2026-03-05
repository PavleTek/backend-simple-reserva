-- CreateTable
CREATE TABLE "ReservationAnalytics" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "restaurantId" TEXT,
    "organizationId" TEXT,
    "reservationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReservationAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReservationAnalytics_date_idx" ON "ReservationAnalytics"("date");

-- CreateIndex
CREATE INDEX "ReservationAnalytics_restaurantId_date_idx" ON "ReservationAnalytics"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "ReservationAnalytics_organizationId_date_idx" ON "ReservationAnalytics"("organizationId", "date");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "ReservationAnalytics_date_restaurantId_key"
  ON "ReservationAnalytics" ("date", "restaurantId")
  WHERE "restaurantId" IS NOT NULL;

-- CreateUniqueIndex
CREATE UNIQUE INDEX "ReservationAnalytics_date_global_key"
  ON "ReservationAnalytics" ("date")
  WHERE "restaurantId" IS NULL;

-- AddForeignKey
ALTER TABLE "ReservationAnalytics" ADD CONSTRAINT "ReservationAnalytics_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAnalytics" ADD CONSTRAINT "ReservationAnalytics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "RestaurantOrganization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
