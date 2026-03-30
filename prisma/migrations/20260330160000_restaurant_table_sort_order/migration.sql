-- AlterTable
ALTER TABLE "RestaurantTable" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Orden inicial: por etiqueta dentro de cada zona (misma lógica que antes)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "zoneId" ORDER BY label ASC) - 1 AS so
  FROM "RestaurantTable"
)
UPDATE "RestaurantTable" AS t
SET "sortOrder" = ranked.so
FROM ranked
WHERE t.id = ranked.id;
