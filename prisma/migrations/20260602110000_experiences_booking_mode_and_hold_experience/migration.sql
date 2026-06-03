-- Migration: experiences_booking_mode_and_hold_experience
--
-- Adds:
--   1. BookingExperienceMode enum + bookingExperienceMode column on Restaurant
--   2. experienceId + FK on ReservationHold → Experience
--   3. inventoryMode column on Experience

-- 1. Enum para el modo de flujo de reserva de actividades
DO $$ BEGIN
  CREATE TYPE "BookingExperienceMode" AS ENUM ('NORMAL', 'EXPERIENCE_FIRST', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Columna bookingExperienceMode en Restaurant
ALTER TABLE "Restaurant"
  ADD COLUMN IF NOT EXISTS "bookingExperienceMode" "BookingExperienceMode" NOT NULL DEFAULT 'NORMAL';

-- 3. experienceId en ReservationHold
ALTER TABLE "ReservationHold"
  ADD COLUMN IF NOT EXISTS "experienceId" TEXT;

-- FK ReservationHold → Experience (SET NULL al borrar)
ALTER TABLE "ReservationHold"
  ADD CONSTRAINT "ReservationHold_experienceId_fkey"
    FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Índice para búsquedas de holds por experiencia
CREATE INDEX IF NOT EXISTS "ReservationHold_experienceId_idx" ON "ReservationHold"("experienceId");

-- 4. inventoryMode en Experience (TABLE_SHARED = default actual; CAPACITY_ONLY = sin mesas)
ALTER TABLE "Experience"
  ADD COLUMN IF NOT EXISTS "inventoryMode" TEXT NOT NULL DEFAULT 'TABLE_SHARED';
