-- Activities domain: replace Experience modifier with independent Activity/Session/Booking

-- Drop Experience relations
ALTER TABLE "ReservationHold" DROP CONSTRAINT IF EXISTS "ReservationHold_experienceId_fkey";
ALTER TABLE "ReservationHold" DROP COLUMN IF EXISTS "experienceId";

ALTER TABLE "Reservation" DROP CONSTRAINT IF EXISTS "Reservation_experienceId_fkey";
DROP INDEX IF EXISTS "Reservation_restaurantId_experienceId_idx";
ALTER TABLE "Reservation" DROP COLUMN IF EXISTS "experienceId";
ALTER TABLE "Reservation" DROP COLUMN IF EXISTS "experienceName";
ALTER TABLE "Reservation" DROP COLUMN IF EXISTS "experiencePricePerPerson";
ALTER TABLE "Reservation" DROP COLUMN IF EXISTS "experienceTotal";

ALTER TABLE "Restaurant" DROP COLUMN IF EXISTS "bookingExperienceMode";

DROP TABLE IF EXISTS "Experience";
DROP TYPE IF EXISTS "BookingExperienceMode";

-- Plan feature flag
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "activitiesModule" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Plan" SET "activitiesModule" = true WHERE "productSKU" = 'plan-premium';

-- Activity enums
CREATE TYPE "ActivityCapacityMode" AS ENUM ('INDEPENDENT', 'BLOCKS_VENUE', 'SHARED_TABLES');
CREATE TYPE "ActivityBlockScope" AS ENUM ('VENUE', 'ZONES');
CREATE TYPE "ActivitySessionStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "ActivityBookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "ActivityCategory" AS ENUM ('TOUR', 'TASTING', 'CLASS', 'EVENT', 'MENU', 'CORPORATE', 'CUSTOM');

CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "category" "ActivityCategory" NOT NULL DEFAULT 'CUSTOM',
    "imageUrl" TEXT,
    "defaultDurationMinutes" INTEGER NOT NULL DEFAULT 60,
    "defaultCapacity" INTEGER,
    "pricePerPerson" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "minimumNoticeMinutes" INTEGER NOT NULL DEFAULT 0,
    "minPartySize" INTEGER NOT NULL DEFAULT 1,
    "maxPartySize" INTEGER,
    "capacityMode" "ActivityCapacityMode" NOT NULL DEFAULT 'INDEPENDENT',
    "blockScope" "ActivityBlockScope",
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "cancellationPolicy" TEXT,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityZone" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,

    CONSTRAINT "ActivityZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivitySession" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "businessDate" DATE NOT NULL,
    "capacity" INTEGER NOT NULL,
    "pricePerPersonOverride" DECIMAL(10,2),
    "status" "ActivitySessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivitySession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityBooking" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "partySize" INTEGER NOT NULL,
    "status" "ActivityBookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "secureToken" TEXT NOT NULL,
    "activityName" TEXT NOT NULL,
    "sessionStartAt" TIMESTAMP(3) NOT NULL,
    "pricePerPerson" DECIMAL(10,2),
    "totalReferential" DECIMAL(10,2),
    "reservationId" TEXT,
    "confirmedByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityBooking_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivitySessionHold" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "holdToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "ActivitySessionHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Activity_restaurantId_slug_key" ON "Activity"("restaurantId", "slug");
CREATE INDEX "Activity_restaurantId_isActive_isDeleted_idx" ON "Activity"("restaurantId", "isActive", "isDeleted");
CREATE UNIQUE INDEX "ActivityZone_activityId_zoneId_key" ON "ActivityZone"("activityId", "zoneId");
CREATE INDEX "ActivitySession_restaurantId_businessDate_status_idx" ON "ActivitySession"("restaurantId", "businessDate", "status");
CREATE INDEX "ActivitySession_activityId_startAt_idx" ON "ActivitySession"("activityId", "startAt");
CREATE UNIQUE INDEX "ActivityBooking_secureToken_key" ON "ActivityBooking"("secureToken");
CREATE UNIQUE INDEX "ActivityBooking_reservationId_key" ON "ActivityBooking"("reservationId");
CREATE INDEX "ActivityBooking_restaurantId_status_idx" ON "ActivityBooking"("restaurantId", "status");
CREATE INDEX "ActivityBooking_sessionId_status_idx" ON "ActivityBooking"("sessionId", "status");
CREATE UNIQUE INDEX "ActivitySessionHold_holdToken_key" ON "ActivitySessionHold"("holdToken");
CREATE INDEX "ActivitySessionHold_sessionId_status_idx" ON "ActivitySessionHold"("sessionId", "status");
CREATE INDEX "ActivitySessionHold_expiresAt_status_idx" ON "ActivitySessionHold"("expiresAt", "status");

ALTER TABLE "Activity" ADD CONSTRAINT "Activity_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityZone" ADD CONSTRAINT "ActivityZone_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityZone" ADD CONSTRAINT "ActivityZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivitySession" ADD CONSTRAINT "ActivitySession_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityBooking" ADD CONSTRAINT "ActivityBooking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ActivitySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityBooking" ADD CONSTRAINT "ActivityBooking_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityBooking" ADD CONSTRAINT "ActivityBooking_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActivitySessionHold" ADD CONSTRAINT "ActivitySessionHold_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ActivitySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
