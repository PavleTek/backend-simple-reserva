-- CreateEnum
CREATE TYPE "BookingAcceptanceMode" AS ENUM ('ALWAYS_24_7', 'DURING_OPERATIONAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BookingClosedFallback" AS ENUM ('DISABLE', 'MESSAGE', 'CONTACT');

-- AlterTable Schedule
ALTER TABLE "Schedule" ADD COLUMN "closesNextDay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Schedule" ADD COLUMN "dinnerEndsNextDay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Reservation
ALTER TABLE "Reservation" ADD COLUMN "businessDate" DATE;

-- AlterTable ReservationWindow
ALTER TABLE "ReservationWindow" ADD COLUMN "endsNextDay" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Restaurant
ALTER TABLE "Restaurant" ADD COLUMN "bookingAcceptanceMode" "BookingAcceptanceMode" NOT NULL DEFAULT 'ALWAYS_24_7';
ALTER TABLE "Restaurant" ADD COLUMN "bookingClosedFallback" "BookingClosedFallback" NOT NULL DEFAULT 'MESSAGE';
ALTER TABLE "Restaurant" ADD COLUMN "bookingClosedMessage" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN "bookingContactPhone" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN "bookingContactWhatsapp" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN "bookingContactEmail" TEXT;

-- CreateTable BookingAcceptanceWindow
CREATE TABLE "BookingAcceptanceWindow" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "endsNextDay" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BookingAcceptanceWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingAcceptanceWindow_restaurantId_dayOfWeek_idx" ON "BookingAcceptanceWindow"("restaurantId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "Reservation_restaurantId_businessDate_status_idx" ON "Reservation"("restaurantId", "businessDate", "status");

-- AddForeignKey
ALTER TABLE "BookingAcceptanceWindow" ADD CONSTRAINT "BookingAcceptanceWindow_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill businessDate from dateTime in restaurant timezone (calendar date; safe for existing data)
UPDATE "Reservation" r
SET "businessDate" = (
  DATE(r."dateTime" AT TIME ZONE COALESCE(
    (SELECT res."timezone" FROM "Restaurant" res WHERE res."id" = r."restaurantId"),
    'America/Santiago'
  ))
)
WHERE r."businessDate" IS NULL;
