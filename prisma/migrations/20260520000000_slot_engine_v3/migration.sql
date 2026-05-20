-- Slot engine v3: motor único clock-aligned, holds temporales, pacing por cupo
-- Migración DATA-PRESERVING: no elimina reservas, horarios, mesas, reglas ni ventanas existentes.
-- Solo añade tablas/columnas nuevas y elimina slotGenerationMode (metadato de motor, no dato de negocio).

-- 1. Preservar el intervalo para restaurantes legacy ANTES de eliminar slotGenerationMode.
--    Restaurantes clock_aligned conservan su slotIntervalMinutes actual sin cambios.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Restaurant'
      AND column_name = 'slotGenerationMode'
  ) THEN
    UPDATE "Restaurant"
    SET "slotIntervalMinutes" = "defaultSlotDurationMinutes"
    WHERE "slotGenerationMode" = 'legacy'
      AND "slotIntervalMinutes" IS DISTINCT FROM "defaultSlotDurationMinutes";

    ALTER TABLE "Restaurant" DROP COLUMN "slotGenerationMode";
  END IF;
END $$;

-- 2. Campos Hold System (defaults seguros; no sobrescribe valores existentes)
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "holdTtlSeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "holdsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- 3. Tabla PacingRule (nueva; vacía al inicio — no afecta datos existentes)
CREATE TABLE IF NOT EXISTS "PacingRule" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "maxCoversPerSlot" INTEGER,
    "maxReservationsPerSlot" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PacingRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PacingRule_restaurantId_idx" ON "PacingRule"("restaurantId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PacingRule_restaurantId_fkey'
  ) THEN
    ALTER TABLE "PacingRule" ADD CONSTRAINT "PacingRule_restaurantId_fkey"
        FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Tabla ReservationHold (nueva; solo holds temporales de checkout)
CREATE TABLE IF NOT EXISTS "ReservationHold" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL,
    "dateTime" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "holdToken" TEXT NOT NULL,
    "sessionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'web',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ReservationHold_holdToken_key" ON "ReservationHold"("holdToken");
CREATE INDEX IF NOT EXISTS "ReservationHold_restaurantId_dateTime_status_idx" ON "ReservationHold"("restaurantId", "dateTime", "status");
CREATE INDEX IF NOT EXISTS "ReservationHold_expiresAt_status_idx" ON "ReservationHold"("expiresAt", "status");
CREATE INDEX IF NOT EXISTS "ReservationHold_holdToken_idx" ON "ReservationHold"("holdToken");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReservationHold_restaurantId_fkey'
  ) THEN
    ALTER TABLE "ReservationHold" ADD CONSTRAINT "ReservationHold_restaurantId_fkey"
        FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ReservationHold_tableId_fkey'
  ) THEN
    ALTER TABLE "ReservationHold" ADD CONSTRAINT "ReservationHold_tableId_fkey"
        FOREIGN KEY ("tableId") REFERENCES "RestaurantTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
