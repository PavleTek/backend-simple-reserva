-- Slot engine v2: legacy mode for existing restaurants, configurable interval & windows

ALTER TABLE "Restaurant" ADD COLUMN "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Restaurant" ADD COLUMN "slotGenerationMode" TEXT NOT NULL DEFAULT 'clock_aligned';
ALTER TABLE "Restaurant" ADD COLUMN "reservationEndPolicy" TEXT NOT NULL DEFAULT 'STRICT_END';
ALTER TABLE "Restaurant" ADD COLUMN "reservationWindowMode" TEXT NOT NULL DEFAULT 'same_as_schedule';

-- Existing restaurants keep identical slot behavior (anchored to window start, step = duration)
UPDATE "Restaurant"
SET
  "slotGenerationMode" = 'legacy',
  "slotIntervalMinutes" = "defaultSlotDurationMinutes";

CREATE TABLE "ReservationWindow" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReservationWindow_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReservationWindow_restaurantId_dayOfWeek_idx" ON "ReservationWindow"("restaurantId", "dayOfWeek");

ALTER TABLE "ReservationWindow" ADD CONSTRAINT "ReservationWindow_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
