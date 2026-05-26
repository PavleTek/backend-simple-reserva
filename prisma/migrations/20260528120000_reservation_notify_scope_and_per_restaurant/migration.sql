-- CreateEnum
CREATE TYPE "ReservationNotifyScope" AS ENUM ('organization', 'restaurant');

-- AlterTable
ALTER TABLE "RestaurantOrganization"
ADD COLUMN "reservationNotifyScope" "ReservationNotifyScope" NOT NULL DEFAULT 'restaurant';

-- AlterTable
ALTER TABLE "Restaurant"
ADD COLUMN "reservationNotifyRecipients" JSONB,
ADD COLUMN "reservationNotifyOnWeb" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "reservationNotifyOnManual" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: copy org notification settings to each restaurant
UPDATE "Restaurant" r
SET
  "reservationNotifyRecipients" = o."reservationNotifyRecipients",
  "reservationNotifyOnWeb" = o."reservationNotifyOnWeb",
  "reservationNotifyOnManual" = o."reservationNotifyOnManual"
FROM "RestaurantOrganization" o
WHERE r."organizationId" = o.id;
