-- CreateEnum
CREATE TYPE "ReservationNotifyAudience" AS ENUM ('owner', 'managers', 'hosts', 'all', 'custom');

-- AlterTable
ALTER TABLE "RestaurantOrganization"
ADD COLUMN "reservationNotifyAudience" "ReservationNotifyAudience" NOT NULL DEFAULT 'owner',
ADD COLUMN "reservationNotifyCustomEmail" TEXT,
ADD COLUMN "reservationNotifyOnWeb" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "reservationNotifyOnManual" BOOLEAN NOT NULL DEFAULT true;
