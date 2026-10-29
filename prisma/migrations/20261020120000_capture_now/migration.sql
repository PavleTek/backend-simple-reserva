-- CAPTURE NOW: phone/walk-in/lifecycle/ticket/attribution/first reservation

ALTER TABLE "RestaurantOrganization"
  ADD COLUMN "signupUtmSource" TEXT,
  ADD COLUMN "signupUtmMedium" TEXT,
  ADD COLUMN "signupUtmCampaign" TEXT,
  ADD COLUMN "signupRefOrgId" TEXT,
  ADD COLUMN "signupLandingPath" TEXT;

ALTER TABLE "Restaurant"
  ADD COLUMN "averageTicketCLP" INTEGER,
  ADD COLUMN "averageTicketUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "firstReservationReceivedAt" TIMESTAMP(3),
  ADD COLUMN "firstReservationId" TEXT;

ALTER TABLE "Reservation"
  ADD COLUMN "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3);

UPDATE "Reservation"
SET "customerPhone" = NULL
WHERE "customerPhone" IN ('—', '-', '–', '−', '');

UPDATE "Reservation"
SET "isWalkIn" = true
WHERE lower(trim("customerName")) IN ('walk-in', 'walk in')
   OR lower(trim(coalesce("notes", ''))) = 'walk-in';

UPDATE "Restaurant" AS r
SET
  "firstReservationReceivedAt" = x."createdAt",
  "firstReservationId" = x.id
FROM (
  SELECT DISTINCT ON ("restaurantId")
    "restaurantId",
    id,
    "createdAt"
  FROM "Reservation"
  ORDER BY "restaurantId", "createdAt" ASC
) AS x
WHERE r.id = x."restaurantId"
  AND r."firstReservationReceivedAt" IS NULL;
