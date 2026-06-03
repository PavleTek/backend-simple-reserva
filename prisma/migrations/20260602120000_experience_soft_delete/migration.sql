-- Soft delete para Experience: ocultar del panel sin borrar datos ni reservas.

ALTER TABLE "Experience"
  ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Experience_restaurantId_isDeleted_idx"
  ON "Experience"("restaurantId", "isDeleted");
