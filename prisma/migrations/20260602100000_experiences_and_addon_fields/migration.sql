-- AddExperienceModel: tabla Experience + campos en Reservation + campos addon org-scoped
-- Migración segura: sólo operaciones ADD (no DROP de columnas existentes no gestionadas aquí).

-- Campos nuevos en SubscriptionAddon (org-scoped + compromiso mínimo)
ALTER TABLE "SubscriptionAddon"
  ADD COLUMN IF NOT EXISTS "activatedAt"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "billingStartsAt"         TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "minimumCommitmentUntil"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "removalScheduledFor"     TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SubscriptionAddon_removalScheduledFor_idx"
  ON "SubscriptionAddon"("removalScheduledFor");

-- Campos de experiencia en Reservation (snapshot al reservar)
ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "experienceId"             TEXT,
  ADD COLUMN IF NOT EXISTS "experienceName"           TEXT,
  ADD COLUMN IF NOT EXISTS "experiencePricePerPerson" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "experienceTotal"          DECIMAL(10,2);

-- Tabla Experience
CREATE TABLE IF NOT EXISTS "Experience" (
    "id"                        TEXT         NOT NULL,
    "restaurantId"              TEXT         NOT NULL,
    "name"                      TEXT         NOT NULL,
    "description"               TEXT,
    "type"                      TEXT         NOT NULL DEFAULT 'custom',
    "imageUrl"                  TEXT,
    "pricePerPerson"            DECIMAL(10,2),
    "required"                  BOOLEAN      NOT NULL DEFAULT false,
    "extendsReservationDuration" BOOLEAN     NOT NULL DEFAULT false,
    "durationMinutes"           INTEGER,
    "featured"                  BOOLEAN      NOT NULL DEFAULT false,
    "minAdvanceNoticeMinutes"   INTEGER,
    "capacityPerSlot"           INTEGER,
    "capacityPerDay"            INTEGER,
    "availableDays"             INTEGER[]    NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "availableFrom"             DATE,
    "availableTo"               DATE,
    "startTime"                 TEXT,
    "endTime"                   TEXT,
    "isActive"                  BOOLEAN      NOT NULL DEFAULT true,
    "sortOrder"                 INTEGER      NOT NULL DEFAULT 0,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Experience_restaurantId_isActive_idx"
  ON "Experience"("restaurantId", "isActive");

CREATE INDEX IF NOT EXISTS "Experience_restaurantId_featured_sortOrder_idx"
  ON "Experience"("restaurantId", "featured", "sortOrder");

CREATE INDEX IF NOT EXISTS "Reservation_restaurantId_experienceId_idx"
  ON "Reservation"("restaurantId", "experienceId");

-- Foreign keys (IF NOT EXISTS usa un bloque DO para compatibilidad)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Reservation_experienceId_fkey'
  ) THEN
    ALTER TABLE "Reservation"
      ADD CONSTRAINT "Reservation_experienceId_fkey"
      FOREIGN KEY ("experienceId") REFERENCES "Experience"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Experience_restaurantId_fkey'
  ) THEN
    ALTER TABLE "Experience"
      ADD CONSTRAINT "Experience_restaurantId_fkey"
      FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
